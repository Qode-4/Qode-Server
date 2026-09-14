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
    content: string;
    created_at: Date;
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
    content: row.content,
    createdAt: row.created_at,
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
    createRoom(params: {
        id: string;
        projectId: string;
        name: string;
        createdBy: string;
    }): Promise<TeamChatRoom>;
    getRoom(chatId: string): Promise<TeamChatRoom | null>;
    getRoomsByProject(projectId: string): Promise<TeamChatRoom[]>;
    listRoomNames(projectId: string, excludeChatId?: string): Promise<string[]>;
    renameRoom(chatId: string, name: string): Promise<TeamChatRoom | null>;
    deleteRoom(chatId: string): Promise<boolean>;
    getParticipantRole(chatId: string, userId: string): Promise<"OWNER" | "ADMIN" | "MEMBER" | null>;
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

    private async addParticipantInternal(
        db: Pool | PoolClient,
        params: { chatId: string; userId: string; role: "OWNER" | "MEMBER" }
    ): Promise<void> {
        await db.query(
            `INSERT INTO chat_participants (chat_id, user_id, member_role)
            VALUES ($1, $2, $3)
            ON CONFLICT (chat_id, user_id) DO NOTHING`,
            [params.chatId, params.userId, params.role]
        );
    }

    async createRoom(params: { id: string; projectId: string; name: string; createdBy: string; }): Promise<TeamChatRoom> {
        const client = await this.pool.connect();

        try {
            await client.query("BEGIN");
            const room = await this.createRoomInternal(client, params);
            await this.addParticipantInternal(client, {
                chatId: room.id,
                userId: params.createdBy,
                role: 'OWNER',
            });
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

    // BR-D3-04 의 "같은 목록 범위" — 팀 채팅은 프로젝트의 팀 채팅 전체다.
    async listRoomNames(projectId: string, excludeChatId?: string): Promise<string[]> {
        const { rows } = await this.pool.query<{ name: string }>(
            `SELECT name FROM chats
             WHERE project_id = $1 AND chat_type = 'TEAM'
               AND ($2::uuid IS NULL OR id <> $2)`,
            [projectId, excludeChatId ?? null]
        );
        return rows.map((row) => row.name);
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

    // 하드 삭제다(BR-D1-04). chat_participants·messages 는 chat_id 가
    // ON DELETE CASCADE 라 방 행 하나만 지우면 함께 지워진다.
    async deleteRoom(chatId: string): Promise<boolean> {
        const { rowCount } = await this.pool.query(
            `DELETE FROM chats WHERE id = $1 AND chat_type = 'TEAM'`,
            [chatId]
        );
        return (rowCount ?? 0) > 0;
    }

    // 방 단위 권한이다. 프로젝트 멤버 역할(project_members)과 다르다 —
    // 방을 만든 사람이 그 방의 OWNER 다.
    async getParticipantRole(chatId: string, userId: string) {
        const { rows } = await this.pool.query<{ member_role: "OWNER" | "ADMIN" | "MEMBER" }>(
            `SELECT member_role FROM chat_participants
             WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [chatId, userId]
        );
        return rows[0]?.member_role ?? null;
    }

    async getRoomsByProject(projectId: string): Promise<TeamChatRoom[]> {
        const { rows } = await this.pool.query<ChatRow>(
            `SELECT id, project_id, name, created_by, created_at
        FROM chats WHERE project_id = $1 AND chat_type = 'TEAM'
        ORDER BY created_at DESC`,
            [projectId]
        );
        return rows.map(toRoom);
    }

    async getMessage(params: {
        chatId: string;
        limit: number;
        before?: Date;
    }): Promise<TeamChatMessage[]> {
        const { rows } = await this.pool.query<MessageRow>(
            `SELECT m.id, m.chat_id, m.user_id, m.content, m.created_at,
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
            `SELECT m.id, m.chat_id, m.user_id, m.content, m.created_at,
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