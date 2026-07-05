// team-chat.repository.test.ts
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { initializeCoreSchema } from "../core-schema/core-schema.repository.js";
import { PgTeamChatRepository } from "./team-chat.repository.js";

let pool: Pool;
let repo: PgTeamChatRepository;

beforeAll(async () => {
    
    pool = new Pool({ connectionString: "postgresql://postgres:postgres@localhost:5432/test_db" });
    await initializeCoreSchema(pool);
    repo = new PgTeamChatRepository(pool);
});

afterAll(async () => {
    await pool.end();
});

beforeEach(async () => {
    // 각 테스트 전에 테이블 초기화
    await pool.query(`
        TRUNCATE TABLE chat_participants, messages, chats, project_members, projects, users
        RESTART IDENTITY CASCADE
    `);
});

const createTestUser = async (email: string) => {
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO users (id, email, password, name) VALUES ($1, $2, 'hash', $3)`,
        [id, email, "TestUser"]
    );
    return id;
};

const createTestProject = async (userId: string) => {
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO projects (id, name, invite_code, created_by_id) VALUES ($1, 'Test Project', 'ABCD1234', $2)`,
        [id, userId]
    );
    await pool.query(
        `INSERT INTO project_members (id, user_id, project_id, role) VALUES ($1, $2, $3, 'OWNER')`,
        [crypto.randomUUID(), userId, id]
    );
    return id;
};

describe("PgTeamChatRepository", () => {

    describe("createRoom", () => {
        it("채팅방을 생성하고 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            const room = await repo.createRoom({
                id: crypto.randomUUID(),
                projectId,
                name: "일반",
                createdBy: userId,
            });

            expect(room.projectId).toBe(projectId);
            expect(room.name).toBe("일반");
            expect(room.createdBy).toBe(userId);
            expect(room.id).toBeDefined();
            expect(room.createdAt).toBeInstanceOf(Date);
        });

        it("채팅방 생성 시 OWNER를 참여자로 추가한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            const room = await repo.createRoom({
                id: crypto.randomUUID(),
                projectId,
                name: "일반",
                createdBy: userId,
            });

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(1);
            expect(participants[0]?.userId).toBe(userId);
            expect(participants[0]?.memberRole).toBe("OWNER");
        });
    });

    describe("getRoom", () => {
        it("존재하는 채팅방을 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const roomId = crypto.randomUUID();

            await repo.createRoom({ id: roomId, projectId, name: "일반", createdBy: userId });

            const room = await repo.getRoom(roomId);
            expect(room).not.toBeNull();
            expect(room?.id).toBe(roomId);
            expect(room?.name).toBe("일반");
        });

        it("존재하지 않는 채팅방은 null을 반환한다", async () => {
            const room = await repo.getRoom(crypto.randomUUID());
            expect(room).toBeNull();
        });
    });

    describe("getRoomsByProject", () => {
        it("프로젝트의 채팅방 목록을 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId });
            await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "공지", createdBy: userId });

            const rooms = await repo.getRoomsByProject(projectId);
            expect(rooms).toHaveLength(2);
        });

        it("다른 프로젝트 채팅방은 포함되지 않는다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId1 = await createTestProject(userId);
            const projectId2 = await createTestProject(userId);

            await repo.createRoom({ id: crypto.randomUUID(), projectId: projectId1, name: "일반", createdBy: userId });
            await repo.createRoom({ id: crypto.randomUUID(), projectId: projectId2, name: "일반", createdBy: userId });

            const rooms = await repo.getRoomsByProject(projectId1);
            expect(rooms).toHaveLength(1);
            expect(rooms[0]?.projectId).toBe(projectId1);
        });

        it("채팅방이 없으면 빈 배열을 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            const rooms = await repo.getRoomsByProject(projectId);
            expect(rooms).toHaveLength(0);
        });

        it("생성 시간 오름차순으로 정렬된다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "첫번째", createdBy: userId });
            await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "두번째", createdBy: userId });

            const rooms = await repo.getRoomsByProject(projectId);
            expect(rooms[0]?.name).toBe("첫번째");
            expect(rooms[1]?.name).toBe("두번째");
        });
    });

    describe("addParticipant", () => {
        it("참여자를 추가한다", async () => {
            const userId1 = await createTestUser("user1@test.com");
            const userId2 = await createTestUser("user2@test.com");
            const projectId = await createTestProject(userId1);

            const room = await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId1 });

            await repo.addParticipant({ chatId: room.id, userId: userId2, role: "MEMBER" });

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(2);
        });

        it("이미 참여 중인 유저는 중복 추가되지 않는다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            const room = await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId });

            await repo.addParticipant({ chatId: room.id, userId, role: "MEMBER" });

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(1);
        });
    });

    describe("getParticipants", () => {
        it("left_at이 있는 참여자는 제외한다", async () => {
            const userId1 = await createTestUser("user1@test.com");
            const userId2 = await createTestUser("user2@test.com");
            const projectId = await createTestProject(userId1);

            const room = await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId1 });
            await repo.addParticipant({ chatId: room.id, userId: userId2, role: "MEMBER" });

            await pool.query(
                `UPDATE chat_participants SET left_at = NOW() WHERE chat_id = $1 AND user_id = $2`,
                [room.id, userId2]
            );

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(1);
            expect(participants[0]?.userId).toBe(userId1);
        });
    });

    describe("getMessage", () => {
        it("메시지가 없으면 빈 배열을 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId });

            const messages = await repo.getMessage({ chatId: room.id, limit: 50 });
            expect(messages).toHaveLength(0);
        });

        it("limit만큼만 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId });

            for (let i = 0; i < 5; i++) {
                await pool.query(
                    `INSERT INTO messages (id, chat_id, user_id, content) VALUES ($1, $2, $3, $4)`,
                    [crypto.randomUUID(), room.id, userId, `메시지 ${i}`]
                );
            }

            const messages = await repo.getMessage({ chatId: room.id, limit: 3 });
            expect(messages).toHaveLength(3);
        });

        it("before 이전 메시지만 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await repo.createRoom({ id: crypto.randomUUID(), projectId, name: "일반", createdBy: userId });

            await pool.query(
                `INSERT INTO messages (id, chat_id, user_id, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
                [crypto.randomUUID(), room.id, userId, "오래된 메시지", new Date("2024-01-01")]
            );
            await pool.query(
                `INSERT INTO messages (id, chat_id, user_id, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
                [crypto.randomUUID(), room.id, userId, "최신 메시지", new Date("2024-06-01")]
            );

            const messages = await repo.getMessage({
                chatId: room.id,
                limit: 50,
                before: new Date("2024-03-01"),
            });

            expect(messages).toHaveLength(1);
            expect(messages[0]?.content).toBe("오래된 메시지");
        });
    });
});