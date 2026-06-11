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
    getMessage(params: {
        chatId: string;
        limit: number;
        before?: Date;
    }): Promise<TeamChatMessage[]>;
    getParticipants(chatId: string): Promise<TeamChatParticipant[]>;
    addParticipant(params: {
        chatId: string;
        userId: string;
        role: "OWNER" | "MEMBER";
    }): Promise<void>;
}

// ------------ InMemory (for the test) ------------

export class InMemoryTeamChatRepository implements TeamChatRepository {
    private readonly rooms = new Map<string, TeamChatRoom>();
    private readonly messages = new Map<string, TeamChatMessage[]>();
    private readonly participants = new Map<string, TeamChatParticipant[]>();

    async createRoom(params: {
        id: string;
        projectId: string;
        name: string;
        createdBy: string;
    }): Promise<TeamChatRoom> {
        const room: TeamChatRoom = {
            id: params.id,
            projectId: params.projectId,
            name: params.name,
            createdBy: params.createdBy,
            createdAt: new Date(),
        };

        this.rooms.set(room.id, room);
        await this.addParticipant({
            chatId: room.id,
            userId: params.createdBy,
            role: "OWNER",
        });
        return room;
    }

    async getRoom(chatId: string): Promise<TeamChatRoom | null> {
        return this.rooms.get(chatId) ?? null;
    }

    async getRoomsByProject(projectId: string): Promise<TeamChatRoom[]> {
        return Array.from(this.rooms.values())
            .filter((r) => r.projectId === projectId)
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    }

    async getMessage(params: {
        chatId: string;
        limit: number;
        before?: Date;
    }): Promise<TeamChatMessage[]> {
        const all = this.messages.get(params.chatId) ?? [];
        return all
            .filter((m) => !params.before || m.createdAt < params.before)
            .slice(-params.limit);
    }

    async getParticipants(chatId: string): Promise<TeamChatParticipant[]> {
        return this.participants.get(chatId) ?? [];
    }

    async addParticipant(params: {
        chatId: string;
        userId: string;
        role: "OWNER" | "MEMBER";
    }): Promise<void> {
        const list = this.participants.get(params.chatId) ?? [];

        list.push({
            chatId: params.chatId,
            userId: params.userId,
            memberRole: params.role,
            joinedAt: new Date(),
            userName: "",   // test용으로 유저 정보 없음 
            avatarUrl: null
        });
        this.participants.set(params.chatId, list);
    }
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

    async getRoomsByProject(projectId: string): Promise<TeamChatRoom[]> {
        const { rows } = await this.pool.query<ChatRow>(
            `SELECT id, project_id, name, created_by, created_at
        FROM chats WHERE project_id = $1 AND chat_type = 'TEAM'
        ORDER BY created_at ASC`,
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
            ORDER BY m.created_at DESC
            LIMIT $2`,
            [params.chatId, params.limit, params.before ?? null]
        );
        return rows.map(toMessage);
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