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

const addProjectMember = async (projectId: string, userId: string, role: "OWNER" | "MEMBER" = "MEMBER") => {
    await pool.query(
        `INSERT INTO project_members (id, user_id, project_id, role) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), userId, projectId, role]
    );
};

const createRoom = async (params: {
    projectId: string;
    createdBy: string;
    name?: string;
    memberIds?: string[];
}) => {
    return repo.createRoomWithParticipants({
        id: crypto.randomUUID(),
        projectId: params.projectId,
        name: params.name ?? "일반",
        createdBy: params.createdBy,
        memberIds: params.memberIds ?? [],
    });
};

describe("PgTeamChatRepository", () => {

    describe("createRoomWithParticipants", () => {
        it("채팅방을 생성하고 OWNER 를 참여자로 넣는다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            const room = await createRoom({ projectId, createdBy: userId });

            expect(room.projectId).toBe(projectId);
            expect(room.name).toBe("일반");
            expect(room.createdBy).toBe(userId);

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(1);
            expect(participants[0]?.userId).toBe(userId);
            expect(participants[0]?.memberRole).toBe("OWNER");
        });

        it("memberIds 를 함께 넣는다", async () => {
            const owner = await createTestUser("owner@test.com");
            const m1 = await createTestUser("m1@test.com");
            const m2 = await createTestUser("m2@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, m1);
            await addProjectMember(projectId, m2);

            const room = await createRoom({ projectId, createdBy: owner, memberIds: [m1, m2] });

            const participants = await repo.getParticipants(room.id);
            expect(participants).toHaveLength(3);
        });

        it("memberIds 에 생성자가 섞여 있어도 중복 삽입하지 않는다", async () => {
            const owner = await createTestUser("owner@test.com");
            const m1 = await createTestUser("m1@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, m1);

            const room = await createRoom({ projectId, createdBy: owner, memberIds: [owner, m1, m1] });

            expect(await repo.getParticipants(room.id)).toHaveLength(2);
        });
    });

    describe("getRoom", () => {
        it("존재하는 채팅방을 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            const created = await createRoom({ projectId, createdBy: userId });

            const room = await repo.getRoom(created.id);
            expect(room).not.toBeNull();
            expect(room?.id).toBe(created.id);
        });

        it("존재하지 않는 채팅방은 null을 반환한다", async () => {
            const room = await repo.getRoom(crypto.randomUUID());
            expect(room).toBeNull();
        });
    });

    describe("getRoomsByProject", () => {
        it("최신 생성순으로 정렬된다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);

            await createRoom({ projectId, createdBy: userId, name: "첫번째" });
            await createRoom({ projectId, createdBy: userId, name: "두번째" });

            const rooms = await repo.getRoomsByProject(projectId);
            expect(rooms[0]?.name).toBe("두번째");
            expect(rooms[1]?.name).toBe("첫번째");
        });

        it("다른 프로젝트 채팅방은 포함되지 않는다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId1 = await createTestProject(userId);
            const projectId2 = await createTestProject(userId);

            await createRoom({ projectId: projectId1, createdBy: userId });
            await createRoom({ projectId: projectId2, createdBy: userId });

            const rooms = await repo.getRoomsByProject(projectId1);
            expect(rooms).toHaveLength(1);
            expect(rooms[0]?.projectId).toBe(projectId1);
        });
    });

    // 명세 — 이름 정규화. FE 는 trim 해서 보내지만 서버는 방어적으로 다시 검사한다.
    describe("nameExists", () => {
        it("같은 이름이면 true", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            await createRoom({ projectId, createdBy: userId, name: "공지" });

            expect(await repo.nameExists(projectId, "공지")).toBe(true);
        });

        it("대소문자만 다르면 같은 이름으로 본다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            await createRoom({ projectId, createdBy: userId, name: "Notice" });

            expect(await repo.nameExists(projectId, "notice")).toBe(true);
        });

        it("앞뒤 공백만 다르면 같은 이름으로 본다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            await createRoom({ projectId, createdBy: userId, name: "공지" });

            expect(await repo.nameExists(projectId, "  공지  ")).toBe(true);
        });

        it("excludeChatId 로 자기 자신은 뺀다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await createRoom({ projectId, createdBy: userId, name: "공지" });

            expect(await repo.nameExists(projectId, "공지", room.id)).toBe(false);
        });

        it("다른 프로젝트 이름은 겹치지 않는다", async () => {
            const userId = await createTestUser("user@test.com");
            const p1 = await createTestProject(userId);
            const p2 = await createTestProject(userId);
            await createRoom({ projectId: p1, createdBy: userId, name: "공지" });

            expect(await repo.nameExists(p2, "공지")).toBe(false);
        });
    });

    describe("addParticipant / 재초대 role reset", () => {
        it("나갔던 사람이 다시 들어올 수 있고 활성 참여자가 된다", async () => {
            const owner = await createTestUser("owner@test.com");
            const member = await createTestUser("member@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, member);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [member] });

            await repo.leaveRoomAndMaybeDeleteChat(room.id, member);
            await repo.addParticipant({ chatId: room.id, userId: member, role: "MEMBER" });

            expect(await repo.getParticipants(room.id)).toHaveLength(2);
        });

        it("이전에 OWNER 였던 사람이 재초대돼도 MEMBER 로 들어간다", async () => {
            // OWNER 자동 복귀 방지 — plan 위험 요소.
            // 방장이 다른 사람에게 양도한 뒤 나갔다가 다시 초대되는 시나리오.
            const owner = await createTestUser("owner@test.com");
            const successor = await createTestUser("succ@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, successor);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [successor] });

            // 방장 양도: successor 가 새 OWNER 가 되고 원 OWNER 는 leave 처리된다.
            await repo.transferOwnership({
                chatId: room.id,
                oldOwnerId: owner,
                newOwnerId: successor,
            });

            // 원 OWNER 를 다시 초대. 재입장 시 role 이 'MEMBER' 로 리셋돼야 한다.
            await repo.addParticipant({ chatId: room.id, userId: owner, role: "MEMBER" });

            expect(await repo.getParticipantRole(room.id, owner)).toBe("MEMBER");
            expect(await repo.getParticipantRole(room.id, successor)).toBe("OWNER");
        });
    });

    describe("kickParticipant", () => {
        it("활성 참여자를 leave 처리한다", async () => {
            const owner = await createTestUser("owner@test.com");
            const member = await createTestUser("member@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, member);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [member] });

            const ok = await repo.kickParticipant(room.id, member);

            expect(ok).toBe(true);
            expect(await repo.getParticipants(room.id)).toHaveLength(1);
        });

        it("이미 나간 사람은 false", async () => {
            const owner = await createTestUser("owner@test.com");
            const stranger = await createTestUser("stranger@test.com");
            const projectId = await createTestProject(owner);
            const room = await createRoom({ projectId, createdBy: owner });

            expect(await repo.kickParticipant(room.id, stranger)).toBe(false);
        });
    });

    // transferOwnership 은 원자적이어야 한다. 중간에 실패하면 방장이 두 명이 되거나 없어지면 안 된다.
    describe("transferOwnership", () => {
        it("새 방장 승격 + 원 방장 leave 가 함께 반영된다", async () => {
            const owner = await createTestUser("owner@test.com");
            const member = await createTestUser("member@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, member);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [member] });

            await repo.transferOwnership({
                chatId: room.id,
                oldOwnerId: owner,
                newOwnerId: member,
            });

            expect(await repo.getParticipantRole(room.id, owner)).toBeNull();
            expect(await repo.getParticipantRole(room.id, member)).toBe("OWNER");
            expect(await repo.getParticipants(room.id)).toHaveLength(1);
        });

        it("newOwner 가 활성 MEMBER 가 아니면 실패하고 원 방장 상태는 그대로", async () => {
            const owner = await createTestUser("owner@test.com");
            const stranger = await createTestUser("stranger@test.com");
            const projectId = await createTestProject(owner);
            const room = await createRoom({ projectId, createdBy: owner });

            await expect(
                repo.transferOwnership({ chatId: room.id, oldOwnerId: owner, newOwnerId: stranger })
            ).rejects.toThrow();

            // 실패했으므로 원 방장은 여전히 OWNER
            expect(await repo.getParticipantRole(room.id, owner)).toBe("OWNER");
        });

        it("oldOwner 가 실제 OWNER 가 아니면 실패한다", async () => {
            const owner = await createTestUser("owner@test.com");
            const member = await createTestUser("member@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, member);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [member] });

            await expect(
                repo.transferOwnership({ chatId: room.id, oldOwnerId: member, newOwnerId: owner })
            ).rejects.toThrow();
        });
    });

    describe("leaveRoomAndMaybeDeleteChat", () => {
        it("나가면 참여자에서 빠진다", async () => {
            const owner = await createTestUser("owner@test.com");
            const member = await createTestUser("member@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, member);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [member] });

            const { deleted } = await repo.leaveRoomAndMaybeDeleteChat(room.id, member);

            expect(deleted).toBe(false);
            expect(await repo.getParticipants(room.id)).toHaveLength(1);
        });

        it("마지막 참여자가 나가면 방이 하드 삭제된다", async () => {
            const owner = await createTestUser("owner@test.com");
            const projectId = await createTestProject(owner);
            const room = await createRoom({ projectId, createdBy: owner });

            const { deleted } = await repo.leaveRoomAndMaybeDeleteChat(room.id, owner);

            expect(deleted).toBe(true);
            expect(await repo.getRoom(room.id)).toBeNull();
        });

        it("두 명이 동시에 마지막 leave 를 해도 방은 한 번만 삭제된다", async () => {
            const a = await createTestUser("a@test.com");
            const b = await createTestUser("b@test.com");
            const projectId = await createTestProject(a);
            await addProjectMember(projectId, b);
            const room = await createRoom({ projectId, createdBy: a, memberIds: [b] });

            // 두 참여자가 동시에 leave — FOR UPDATE 로 순서가 정해지므로 한 명은 deleted:true,
            // 다른 한 명은 방이 이미 지워져 deleted:false 를 받는다.
            const [r1, r2] = await Promise.all([
                repo.leaveRoomAndMaybeDeleteChat(room.id, a),
                repo.leaveRoomAndMaybeDeleteChat(room.id, b),
            ]);

            const deletedCount = [r1.deleted, r2.deleted].filter(Boolean).length;
            expect(deletedCount).toBe(1);
            expect(await repo.getRoom(room.id)).toBeNull();
        });
    });

    describe("countActiveParticipants / findOldestActiveParticipant", () => {
        it("활성 참여자 수를 센다", async () => {
            const owner = await createTestUser("owner@test.com");
            const m1 = await createTestUser("m1@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, m1);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [m1] });

            expect(await repo.countActiveParticipants(room.id)).toBe(2);
        });

        it("가장 오래된 참여자를 찾는다 (자신 제외)", async () => {
            const owner = await createTestUser("owner@test.com");
            const first = await createTestUser("first@test.com");
            const second = await createTestUser("second@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, first);
            await addProjectMember(projectId, second);
            const room = await createRoom({ projectId, createdBy: owner, memberIds: [first, second] });

            const oldest = await repo.findOldestActiveParticipant(room.id, owner);
            expect(oldest).toBe(first);
        });
    });

    describe("findActiveTeamChatIdsByMember", () => {
        it("특정 유저가 활성으로 속한 팀 채팅과 그 방 역할을 반환한다", async () => {
            const owner = await createTestUser("owner@test.com");
            const other = await createTestUser("other@test.com");
            const projectId = await createTestProject(owner);
            await addProjectMember(projectId, other);
            const r1 = await createRoom({ projectId, createdBy: owner, memberIds: [other], name: "A" });
            const r2 = await createRoom({ projectId, createdBy: other, memberIds: [owner], name: "B" });

            const forOther = await repo.findActiveTeamChatIdsByMember(projectId, other);

            const map = new Map(forOther.map((x) => [x.chatId, x.memberRole] as const));
            expect(map.get(r1.id)).toBe("MEMBER");
            expect(map.get(r2.id)).toBe("OWNER");
        });
    });

    describe("getMessage", () => {
        it("메시지가 없으면 빈 배열을 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await createRoom({ projectId, createdBy: userId });

            const messages = await repo.getMessage({ chatId: room.id, limit: 50 });
            expect(messages).toHaveLength(0);
        });

        it("limit만큼만 반환한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await createRoom({ projectId, createdBy: userId });

            for (let i = 0; i < 5; i++) {
                await pool.query(
                    `INSERT INTO messages (id, chat_id, user_id, content) VALUES ($1, $2, $3, $4)`,
                    [crypto.randomUUID(), room.id, userId, `메시지 ${i}`]
                );
            }

            const messages = await repo.getMessage({ chatId: room.id, limit: 3 });
            expect(messages).toHaveLength(3);
        });
    });
});
