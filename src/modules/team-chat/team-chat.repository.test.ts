// team-chat.repository.test.ts
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { initializeCoreSchema } from "../core-schema/core-schema.repository.js";
import { PgTeamChatRepository } from "./team-chat.repository.js";

let pool: Pool;
let repo: PgTeamChatRepository;

beforeAll(async () => {
    pool = new Pool({ connectionString: "postgresql://localhost:5432/test_db" });
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

describe("PgTeamChatRepository", () => {
    // 테스트용 유저/프로젝트 생성 헬퍼
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

    describe("createRoom", () => {
        it("채팅방을 생성하고 OWNER를 참여자로 추가한다", async () => {
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

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(1);
            expect(participants[0]?.userId).toBe(userId);
            expect(participants[0]?.memberRole).toBe("OWNER");
        });
    });

    describe("getRoom", () => {
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
    });
});