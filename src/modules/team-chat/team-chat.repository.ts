import type { Pool, PoolClient } from "pg";
import type {
    TeamChatMessage,
    TeamChatParticipant,
    TeamChatRoom
} from "./team-chat.types.js";

// row type
type ChatRow = {
    id: string;
    project_id: string;
    name: string;
    created_by: string;
    created_at: Date;
}

type MessageRow = {
    id: string;
    chat_id: string;
    user_id: string;
    role: "USER" | "ASSISTANT" | "SYSTEM";
    content: string;
    sources: unknown[] | null;
    created_at: Date;
    deleted_at: Date | null;
    user_name: string;
    avatar_url: string | null;
}

type ParticipantRow = {
    chat_id: string;
    user_id: string;
    member_role: "OWNER" | "ADMIN" | "MEMBER";
    created_at: Date;
    user_name: string;
    avatar_url: string | null;
};

// row -> domain 타입 변환
const toRoom = (row: ChatRow): TeamChatRoom => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at
});

const toMessage = (row: MessageRow): TeamChatMessage => ({
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    sources: row.sources ?? [],
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    userName: row.user_name,
    avatarUrl: row.avatar_url,
});

const toParticipant = (row: ParticipantRow): TeamChatParticipant => ({
    chatId: row.chat_id,
    userId: row.user_id,
    memberRole: row.member_role,
    joinedAt: row.created_at,
    userName: row.user_name,
    avatarUrl: row.avatar_url,
});

export interface TeamChatRepository {
    createRoomWithParticipants(params: {
        id: string;
        projectId: string;
        name: string;
        createdBy: string;
        memberIds: string[];
    }): Promise<TeamChatRoom>;
    getRoom(chatId: string): Promise<TeamChatRoom | null>;
    countRooms(projectId: string): Promise<number>;
    // 사용자 사이드바용. 현재 사용자가 활성 참여자(left_at IS NULL)인 방만 반환한다.
    getRoomsByProject(projectId: string, currentUserId: string): Promise<TeamChatRoom[]>;
    nameExists(projectId: string, name: string, excludeChatId?: string): Promise<boolean>;
    renameRoom(chatId: string, name: string): Promise<TeamChatRoom | null>;
    deleteRoom(chatId: string): Promise<boolean>;
    getParticipantRole(chatId: string, userId: string): Promise<"OWNER" | "ADMIN" | "MEMBER" | null>;
    leaveRoomAndMaybeDeleteChat(chatId: string, userId: string): Promise<{ deleted: boolean }>;
    kickParticipant(chatId: string, userId: string): Promise<boolean>;
    transferOwnership(params: {
        chatId: string;
        oldOwnerId: string;
        newOwnerId: string;
    }): Promise<void>;
    countActiveParticipants(chatId: string): Promise<number>;
    findOldestActiveParticipant(chatId: string, excludeUserId: string): Promise<string | null>;
    findActiveTeamChatIdsByMember(
        projectId: string,
        userId: string
    ): Promise<Array<{ chatId: string; memberRole: "OWNER" | "ADMIN" | "MEMBER" }>>;
    getMessage(params: {
        chatId: string;
        limit: number;
        before?: Date;
    }): Promise<TeamChatMessage[]>;
    insertMessage(params: {
        chatId: string;
        userId: string;
        content: string;
    }): Promise<TeamChatMessage>;
    getParticipants(chatId: string): Promise<TeamChatParticipant[]>;
    addParticipant(params: {
        chatId: string;
        userId: string;
        role: "OWNER" | "MEMBER";
    }): Promise<void>;
}

// ------------ Pg ------------
export class PgTeamChatRepository implements TeamChatRepository {
    constructor(private readonly pool: Pool) { }

    private async createRoomInternal(
        db: Pool | PoolClient,
        params: {
            id: string;
            projectId: string;
            name: string;
            createdBy: string
        }
    ): Promise<TeamChatRoom> {
        const { rows } = await db.query<ChatRow>(
            `INSERT INTO chats (id, project_id, name, created_by, chat_type)
            VALUES ($1, $2, $3, $4, 'TEAM')
            RETURNING id, project_id, name, created_by, created_at`,
            [params.id, params.projectId, params.name, params.createdBy]
        );

        if (!rows[0]) {
            throw new Error("Failed to create room");
        }

        return toRoom(rows[0]);
    }

    // ON CONFLICT DO UPDATE 로 재입장을 처리한다. member_role 을 항상 'MEMBER' 로 되돌려서,
    // 이전에 OWNER 였던 사람이 다시 초대돼도 자동으로 방장이 되지 않도록 한다.
    private async addParticipantInternal(
        db: Pool | PoolClient,
        params: { chatId: string; userId: string; role: "OWNER" | "MEMBER" }
    ): Promise<void> {
        await db.query(
            `INSERT INTO chat_participants (chat_id, user_id, member_role)
            VALUES ($1, $2, $3)
            ON CONFLICT (chat_id, user_id) DO UPDATE
              SET left_at = NULL,
                  member_role = 'MEMBER'`,
            [params.chatId, params.userId, params.role]
        );
    }

    async createRoomWithParticipants(params: {
        id: string;
        projectId: string;
        name: string;
        createdBy: string;
        memberIds: string[];
    }): Promise<TeamChatRoom> {
        // 방어적 dedupe — 서비스에서 이미 걸러도 여기서 한 번 더 잘라낸다.
        const others = Array.from(
            new Set(params.memberIds.filter((id) => id !== params.createdBy))
        );

        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const room = await this.createRoomInternal(client, {
                id: params.id,
                projectId: params.projectId,
                name: params.name,
                createdBy: params.createdBy,
            });

            await this.addParticipantInternal(client, {
                chatId: room.id,
                userId: params.createdBy,
                role: "OWNER",
            });
            for (const userId of others) {
                await this.addParticipantInternal(client, {
                    chatId: room.id,
                    userId,
                    role: "MEMBER",
                });
            }

            await client.query("COMMIT");
            return room;
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    async addParticipant(params: {
        chatId: string;
        userId: string;
        role: "OWNER" | "MEMBER";
    }): Promise<void> {
        await this.addParticipantInternal(this.pool, params);
    }

    async getRoom(chatId: string): Promise<TeamChatRoom | null> {
        const { rows } = await this.pool.query<ChatRow>(
            `SELECT id, project_id, name, created_by, created_at
            FROM chats WHERE id = $1 AND chat_type = 'TEAM'`,
            [chatId]
        );

        return rows[0] ? toRoom(rows[0]) : null;
    }

    // 같은 프로젝트 안의 활성 팀 채팅 중에 이름이 겹치는지 본다.
    // trim + lower 로 정규화해서 눈으로 구분되지 않는 차이는 같은 이름으로 취급한다.
    async nameExists(projectId: string, name: string, excludeChatId?: string): Promise<boolean> {
        const { rows } = await this.pool.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM chats
               WHERE project_id = $1
                 AND chat_type = 'TEAM'
                 AND lower(btrim(name)) = lower(btrim($2))
                 AND ($3::uuid IS NULL OR id <> $3)
             ) AS exists`,
            [projectId, name, excludeChatId ?? null]
        );
        return rows[0]?.exists ?? false;
    }

    async renameRoom(chatId: string, name: string): Promise<TeamChatRoom | null> {
        const { rows } = await this.pool.query<ChatRow>(
            `UPDATE chats SET name = $2
             WHERE id = $1 AND chat_type = 'TEAM'
             RETURNING id, project_id, name, created_by, created_at`,
            [chatId, name]
        );
        const row = rows[0];
        return row ? toRoom(row) : null;
    }

    // 하드 삭제다. chat_participants·messages 는 chat_id 가
    // ON DELETE CASCADE 라 방 행 하나만 지우면 함께 지워진다.
    async deleteRoom(chatId: string): Promise<boolean> {
        const { rowCount } = await this.pool.query(
            `DELETE FROM chats WHERE id = $1 AND chat_type = 'TEAM'`,
            [chatId]
        );
        return (rowCount ?? 0) > 0;
    }

    // 강퇴는 leave 와 같은 소프트 삭제(left_at)를 쓴다. 메시지 히스토리는 남긴다.
    async kickParticipant(chatId: string, userId: string): Promise<boolean> {
        const { rowCount } = await this.pool.query(
            `UPDATE chat_participants SET left_at = NOW()
             WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [chatId, userId]
        );
        return (rowCount ?? 0) > 0;
    }

    // 원자성 보장 — 두 참여자 행을 FOR UPDATE 로 잠근 뒤 새 방장 승격 + 원 방장 leave 처리.
    // 중간 단계에서 실패하면 롤백돼 방장이 두 명이 되거나 없어지는 상태가 남지 않는다.
    async transferOwnership(params: {
        chatId: string;
        oldOwnerId: string;
        newOwnerId: string;
    }): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");

            const { rows } = await client.query<{
                user_id: string;
                member_role: "OWNER" | "ADMIN" | "MEMBER";
                left_at: Date | null;
            }>(
                `SELECT user_id, member_role, left_at
                 FROM chat_participants
                 WHERE chat_id = $1 AND user_id = ANY($2::uuid[])
                 FOR UPDATE`,
                [params.chatId, [params.oldOwnerId, params.newOwnerId]]
            );

            const oldRow = rows.find((r) => r.user_id === params.oldOwnerId);
            const newRow = rows.find((r) => r.user_id === params.newOwnerId);

            if (!oldRow || oldRow.left_at !== null || oldRow.member_role !== "OWNER") {
                throw new Error("OLD_OWNER_INVALID");
            }
            if (!newRow || newRow.left_at !== null || newRow.member_role === "OWNER") {
                throw new Error("NEW_OWNER_INVALID");
            }

            await client.query(
                `UPDATE chat_participants SET member_role = 'OWNER'
                 WHERE chat_id = $1 AND user_id = $2`,
                [params.chatId, params.newOwnerId]
            );
            await client.query(
                `UPDATE chat_participants
                 SET member_role = 'MEMBER', left_at = NOW()
                 WHERE chat_id = $1 AND user_id = $2`,
                [params.chatId, params.oldOwnerId]
            );

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    // 나가기 + 마지막 참여자였다면 방 삭제까지 한 트랜잭션 안에서 처리한다.
    // chats 를 먼저 잠가서 두 명이 동시에 나갈 때 한쪽만 삭제하도록 한다.
    async leaveRoomAndMaybeDeleteChat(
        chatId: string,
        userId: string
    ): Promise<{ deleted: boolean }> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const lockRes = await client.query<{ id: string }>(
                `SELECT id FROM chats
                 WHERE id = $1 AND chat_type = 'TEAM'
                 FOR UPDATE`,
                [chatId]
            );
            if (lockRes.rows.length === 0) {
                await client.query("COMMIT");
                return { deleted: false };
            }

            await client.query(
                `UPDATE chat_participants SET left_at = NOW()
                 WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
                [chatId, userId]
            );

            const { rows } = await client.query<{ count: string }>(
                `SELECT COUNT(*)::text AS count
                 FROM chat_participants
                 WHERE chat_id = $1 AND left_at IS NULL`,
                [chatId]
            );
            const remaining = Number(rows[0]?.count ?? 0);

            let deleted = false;
            if (remaining === 0) {
                await client.query(`DELETE FROM chats WHERE id = $1`, [chatId]);
                deleted = true;
            }

            await client.query("COMMIT");
            return { deleted };
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    async countActiveParticipants(chatId: string): Promise<number> {
        const { rows } = await this.pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM chat_participants
             WHERE chat_id = $1 AND left_at IS NULL`,
            [chatId]
        );
        return Number(rows[0]?.count ?? 0);
    }

    // 자동 방장 양도용 — 나가는 방장 자신은 뺀 가장 오래된 활성 참여자.
    async findOldestActiveParticipant(
        chatId: string,
        excludeUserId: string
    ): Promise<string | null> {
        const { rows } = await this.pool.query<{ user_id: string }>(
            `SELECT user_id FROM chat_participants
             WHERE chat_id = $1 AND user_id <> $2 AND left_at IS NULL
             ORDER BY created_at ASC
             LIMIT 1`,
            [chatId, excludeUserId]
        );
        return rows[0]?.user_id ?? null;
    }

    // 프로젝트 강퇴 훅 — 이 유저가 활성 참여자인 팀 채팅과 그 안의 방 역할을 함께 반환한다.
    async findActiveTeamChatIdsByMember(
        projectId: string,
        userId: string
    ): Promise<Array<{ chatId: string; memberRole: "OWNER" | "ADMIN" | "MEMBER" }>> {
        const { rows } = await this.pool.query<{
            chat_id: string;
            member_role: "OWNER" | "ADMIN" | "MEMBER";
        }>(
            `SELECT c.id AS chat_id, p.member_role
             FROM chats c
             JOIN chat_participants p ON p.chat_id = c.id
             WHERE c.project_id = $1
               AND c.chat_type = 'TEAM'
               AND p.user_id = $2
               AND p.left_at IS NULL`,
            [projectId, userId]
        );
        return rows.map((row) => ({ chatId: row.chat_id, memberRole: row.member_role }));
    }

    async getParticipantRole(chatId: string, userId: string) {
        const { rows } = await this.pool.query<{ member_role: "OWNER" | "ADMIN" | "MEMBER" }>(
            `SELECT member_role FROM chat_participants
             WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [chatId, userId]
        );
        return rows[0]?.member_role ?? null;
    }

    // 팀 채팅방은 프로젝트 멤버 누구에게나 보이는 공용 자원이라 프로젝트 단위로 센다.
    async countRooms(projectId: string): Promise<number> {
        const { rows } = await this.pool.query<{ count: string }>(
            `SELECT count(*) AS count FROM chats WHERE project_id = $1 AND chat_type = 'TEAM'`,
            [projectId]
        );
        return Number(rows[0]?.count ?? 0);
    }

    async getRoomsByProject(projectId: string, currentUserId: string): Promise<TeamChatRoom[]> {
        // 나간 방(left_at IS NOT NULL) 이나 애초에 참여자가 아닌 방은 사이드바에서 감춘다.
        // chat_participants 를 INNER JOIN 해 활성 참여자인 방만 걸러낸다.
        const { rows } = await this.pool.query<ChatRow>(
            `SELECT c.id, c.project_id, c.name, c.created_by, c.created_at
             FROM chats c
             INNER JOIN chat_participants cp
               ON cp.chat_id = c.id
              AND cp.user_id = $2
              AND cp.left_at IS NULL
             WHERE c.project_id = $1 AND c.chat_type = 'TEAM'
             ORDER BY c.created_at DESC`,
            [projectId, currentUserId]
        );
        return rows.map(toRoom);
    }

    async getMessage(params: {
        chatId: string;
        limit: number;
        before?: Date;
    }): Promise<TeamChatMessage[]> {
        // 삭제(digest 카드 회수) 된 행도 그대로 반환한다. 필터하면 리스트가 축소돼 UI 스크롤이 튀고,
        // 프론트가 "삭제된 공유입니다" placeholder 를 못 그린다. deleted_at 값으로 판별을 넘긴다.
        // digest 공유 카드는 user_id=공유자·role=ASSISTANT 로 저장되므로 users JOIN 이 그대로 성립한다.
        const { rows } = await this.pool.query<MessageRow>(
            `SELECT m.id, m.chat_id, m.user_id, m.role, m.content, m.sources,
                    m.created_at, m.deleted_at,
                    u.name AS user_name, u.avatar_url
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.chat_id = $1
                AND ($3::timestamptz IS NULL OR m.created_at < $3)
            ORDER BY m.created_at ASC
            LIMIT $2`,
            [params.chatId, params.limit, params.before ?? null]
        );
        return rows.map(toMessage);
    }

    async insertMessage(params: { chatId: string; userId: string; content: string; }): Promise<TeamChatMessage> {
        const id = crypto.randomUUID();

        await this.pool.query(
            `INSERT INTO messages (id, chat_id, user_id, content, role)
            VALUES ($1, $2, $3, $4, 'USER')`,
            [id, params.chatId, params.userId, params.content]
        );

        const { rows } = await this.pool.query<MessageRow>(
            `SELECT m.id, m.chat_id, m.user_id, m.role, m.content, m.sources,
                    m.created_at, m.deleted_at,
                    u.name AS user_name, u.avatar_url
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.id = $1`,
            [id]
        );

        if (!rows[0]) {
            throw new Error("Failed to insert message");
        }

        return toMessage(rows[0]);
    }

    async getParticipants(chatId: string): Promise<TeamChatParticipant[]> {
        const { rows } = await this.pool.query<ParticipantRow>(
            `SELECT cp.chat_id, cp.user_id, cp.member_role, cp.created_at,
                u.name AS user_name, u.avatar_url
            FROM chat_participants cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.chat_id = $1 AND cp.left_at IS NULL`,
            [chatId]
        );
        return rows.map(toParticipant);
    }
}
