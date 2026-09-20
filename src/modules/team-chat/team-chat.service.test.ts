import { describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { MAX_TEAM_CHAT_ROOMS, TeamChatService } from "./team-chat.service.js";
import { TEAM_CHAT_MAX_PARTICIPANTS } from "./team-chat.schema.js";

type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
type ProjectRole = "OWNER" | "MEMBER";

type BuildOpts = {
    room?: { projectId: string } | null;
    projectRole?: ProjectRole | null;
    roomRole?: MemberRole | null;
    targetRoomRole?: MemberRole | null;
    targetProjectRole?: ProjectRole | null;
    projectRoleMap?: Map<string, ProjectRole>;
    nameExists?: boolean;
    roomCount?: number;
    activeCount?: number;
    activeRooms?: Array<{ chatId: string; memberRole: MemberRole }>;
    oldest?: string | null;
};

const build = (opts: BuildOpts) => {
    const createdRooms: Array<Record<string, unknown>> = [];
    const renamed: string[] = [];
    const deleted: string[] = [];
    const addedParticipants: string[] = [];
    const kicked: Array<{ chatId: string; userId: string }> = [];
    const transfers: Array<{ chatId: string; oldOwnerId: string; newOwnerId: string }> = [];
    const leaves: string[] = [];
    let deletedByLeave = false;

    const repository = {
        countRooms: async () => opts.roomCount ?? 0,
        createRoomWithParticipants: async (params: Record<string, unknown>) => {
            createdRooms.push(params);
            return { id: "c1", projectId: params.projectId, name: params.name, createdBy: params.createdBy, createdAt: new Date() };
        },
        getRoom: async () => (opts.room === undefined ? { projectId: "p1" } : opts.room),
        nameExists: async () => opts.nameExists ?? false,
        renameRoom: async (_id: string, name: string) => {
            renamed.push(name);
            return { id: "c1", projectId: "p1", name, createdBy: "u1", createdAt: new Date() };
        },
        deleteRoom: async (chatId: string) => {
            deleted.push(chatId);
            return true;
        },
        getParticipantRole: async (_chatId: string, userId: string) => {
            if (userId === "u1") return opts.roomRole === undefined ? "OWNER" : opts.roomRole;
            return opts.targetRoomRole === undefined ? "MEMBER" : opts.targetRoomRole;
        },
        addParticipant: async (p: { userId: string }) => {
            addedParticipants.push(p.userId);
        },
        kickParticipant: async (chatId: string, userId: string) => {
            kicked.push({ chatId, userId });
            return true;
        },
        transferOwnership: async (p: { chatId: string; oldOwnerId: string; newOwnerId: string }) => {
            transfers.push(p);
        },
        leaveRoomAndMaybeDeleteChat: async (_c: string, userId: string) => {
            leaves.push(userId);
            return { deleted: deletedByLeave };
        },
        countActiveParticipants: async () => opts.activeCount ?? 3,
        findActiveTeamChatIdsByMember: async () => opts.activeRooms ?? [],
        findOldestActiveParticipant: async () => opts.oldest ?? null,
    };

    const projectRepository = {
        existsById: async () => true,
        findMemberRole: async (_p: string, userId: string) => {
            if (userId === "u1") return opts.projectRole === undefined ? "MEMBER" : opts.projectRole;
            return opts.targetProjectRole === undefined ? "MEMBER" : opts.targetProjectRole;
        },
        findMemberRoles: async (_p: string, userIds: string[]) => {
            if (opts.projectRoleMap) return opts.projectRoleMap;
            const map = new Map<string, ProjectRole>();
            for (const id of userIds) map.set(id, "MEMBER");
            return map;
        },
    };

    const service = new TeamChatService(repository as never, projectRepository as never);
    const setLastLeaveDeleted = (v: boolean) => {
        deletedByLeave = v;
    };
    return { service, renamed, deleted, addedParticipants, kicked, transfers, leaves, createdRooms, setLastLeaveDeleted };
};

const capture = async (fn: () => Promise<unknown>): Promise<HttpError | null> => {
    try {
        await fn();
        return null;
    } catch (error) {
        return error instanceof HttpError ? error : null;
    }
};

// 명세 D-3 / BR-D3-02
describe("팀 채팅방 이름 변경", () => {
    const rename = (service: ReturnType<typeof build>["service"], name = "공지") =>
        service.renameRoomOrThrow({ chatId: "c1", name, currentUserId: "u1" });

    it("프로젝트 멤버면 바꿀 수 있다", async () => {
        const { service, renamed } = build({});
        await rename(service);
        expect(renamed).toEqual(["공지"]);
    });

    it("프로젝트 멤버가 아니면 403", async () => {
        const { service } = build({ projectRole: null });
        expect((await capture(() => rename(service)))?.statusCode).toBe(403);
    });

    it("없는 방이면 404", async () => {
        const { service } = build({ room: null });
        expect((await capture(() => rename(service)))?.statusCode).toBe(404);
    });

    it("같은 이름이 이미 있으면 409", async () => {
        const { service } = build({ nameExists: true });
        expect((await capture(() => rename(service)))?.statusCode).toBe(409);
    });

    it("이름은 trim 해서 저장한다", async () => {
        const { service, renamed } = build({});
        await service.renameRoomOrThrow({ chatId: "c1", name: "  공지  ", currentUserId: "u1" });
        expect(renamed).toEqual(["공지"]);
    });
});

// 명세 D-1 / BR-D1-04 — 하드 삭제
describe("팀 채팅방 삭제", () => {
    const remove = (service: ReturnType<typeof build>["service"]) =>
        service.deleteRoomOrThrow({ chatId: "c1", currentUserId: "u1" });

    it("방 OWNER 는 삭제할 수 있다", async () => {
        const { service, deleted } = build({ roomRole: "OWNER" });
        await remove(service);
        expect(deleted).toEqual(["c1"]);
    });

    it("방 참여자라도 OWNER 가 아니면 403", async () => {
        const { service } = build({ roomRole: "MEMBER" });
        expect((await capture(() => remove(service)))?.statusCode).toBe(403);
    });

    it("방 참여자가 아니면 403", async () => {
        const { service } = build({ roomRole: null });
        expect((await capture(() => remove(service)))?.statusCode).toBe(403);
    });
});

describe("팀 채팅방 생성", () => {
    const create = (
        service: ReturnType<typeof build>["service"],
        memberIds: string[],
        name = "일반"
    ) => service.createRoom({ projectId: "p1", name, memberIds, currentUserId: "u1" });

    it("생성자와 members 로 방을 만든다", async () => {
        const { service, createdRooms } = build({});
        await create(service, ["m1", "m2"]);
        expect(createdRooms).toHaveLength(1);
        expect(createdRooms[0]?.memberIds).toEqual(["m1", "m2"]);
    });

    it("생성자 본인이 memberIds 에 섞여 있어도 제외한다", async () => {
        const { service, createdRooms } = build({});
        await create(service, ["u1", "m1"]);
        expect(createdRooms[0]?.memberIds).toEqual(["m1"]);
    });

    it("중복된 memberIds 는 dedupe 한다", async () => {
        const { service, createdRooms } = build({});
        await create(service, ["m1", "m1", "m2"]);
        expect(createdRooms[0]?.memberIds).toEqual(["m1", "m2"]);
    });

    it("혼자만 남는(1명) 상황은 400", async () => {
        // memberIds 에 자기 자신만 넘겨서 dedupe 이후 0명 남음 → 총 1명 → MIN 미만
        const { service } = build({});
        expect((await capture(() => create(service, ["u1"])))?.statusCode).toBe(400);
    });

    it("MAX 를 넘으면 400", async () => {
        const many = Array.from({ length: TEAM_CHAT_MAX_PARTICIPANTS }, (_, i) => `m${i + 1}`);
        const { service } = build({});
        expect((await capture(() => create(service, many)))?.statusCode).toBe(400);
    });

    it("프로젝트 비멤버가 섞여 있으면 400", async () => {
        // findMemberRoles 가 빈 맵을 돌려주도록
        const { service } = build({ projectRoleMap: new Map() });
        expect((await capture(() => create(service, ["m1"])))?.statusCode).toBe(400);
    });

    it("이름 중복이면 409", async () => {
        const { service } = build({ nameExists: true });
        expect((await capture(() => create(service, ["m1"])))?.statusCode).toBe(409);
    });

    it("프로젝트 멤버가 아니면 403", async () => {
        const { service } = build({ projectRole: null });
        expect((await capture(() => create(service, ["m1"])))?.statusCode).toBe(403);
    });
});

// 명세 D-5 — 참여자 추가 권한을 프로젝트 OWNER 전용에서 방 참여자 누구나로 넓힌다.
describe("팀 채팅방 참여자 추가", () => {
    const add = (service: ReturnType<typeof build>["service"], userId = "u2") =>
        service.addParticipant({ chatId: "c1", userId, currentUserId: "u1" });

    it("방 참여자는 추가할 수 있다", async () => {
        const { service, addedParticipants } = build({ roomRole: "MEMBER", targetRoomRole: null });
        await add(service);
        expect(addedParticipants).toEqual(["u2"]);
    });

    it("방 참여자가 아니면 403", async () => {
        const { service } = build({ roomRole: null, projectRole: "OWNER" });
        expect((await capture(() => add(service)))?.statusCode).toBe(403);
    });

    it("대상이 프로젝트 멤버가 아니면 403", async () => {
        const { service } = build({ roomRole: "MEMBER", targetProjectRole: null });
        expect((await capture(() => add(service)))?.statusCode).toBe(403);
    });

    it("이미 활성 참여자면 409", async () => {
        const { service } = build({ roomRole: "OWNER", targetRoomRole: "MEMBER" });
        expect((await capture(() => add(service)))?.statusCode).toBe(409);
    });

    it("방 인원이 MAX 면 409", async () => {
        const { service } = build({
            roomRole: "OWNER",
            targetRoomRole: null,
            activeCount: TEAM_CHAT_MAX_PARTICIPANTS,
        });
        expect((await capture(() => add(service)))?.statusCode).toBe(409);
    });
});

// 강퇴
describe("팀 채팅방 강퇴", () => {
    const kick = (
        service: ReturnType<typeof build>["service"],
        targetUserId = "u2"
    ) => service.kickParticipant({ chatId: "c1", targetUserId, currentUserId: "u1" });

    it("방장은 다른 활성 참여자를 강퇴할 수 있다", async () => {
        const { service, kicked } = build({ roomRole: "OWNER", targetRoomRole: "MEMBER" });
        await kick(service);
        expect(kicked).toEqual([{ chatId: "c1", userId: "u2" }]);
    });

    it("방장이 아니면 403", async () => {
        const { service } = build({ roomRole: "MEMBER", targetRoomRole: "MEMBER" });
        expect((await capture(() => kick(service)))?.statusCode).toBe(403);
    });

    it("자기 자신은 강퇴할 수 없다 (400)", async () => {
        const { service } = build({ roomRole: "OWNER" });
        expect((await capture(() => kick(service, "u1")))?.statusCode).toBe(400);
    });

    it("대상이 활성 참여자가 아니면 400", async () => {
        const { service } = build({ roomRole: "OWNER", targetRoomRole: null });
        expect((await capture(() => kick(service)))?.statusCode).toBe(400);
    });
});

// 방장 양도
describe("팀 채팅방 방장 양도", () => {
    const transfer = (
        service: ReturnType<typeof build>["service"],
        newOwnerId = "u2"
    ) => service.transferOwnership({ chatId: "c1", newOwnerId, currentUserId: "u1" });

    it("방장은 다른 활성 MEMBER 에게 양도할 수 있다", async () => {
        const { service, transfers } = build({ roomRole: "OWNER", targetRoomRole: "MEMBER" });
        await transfer(service);
        expect(transfers).toEqual([{ chatId: "c1", oldOwnerId: "u1", newOwnerId: "u2" }]);
    });

    it("자기 자신에게는 양도할 수 없다 (400)", async () => {
        const { service } = build({ roomRole: "OWNER" });
        expect((await capture(() => transfer(service, "u1")))?.statusCode).toBe(400);
    });

    it("방장이 아니면 403", async () => {
        const { service } = build({ roomRole: "MEMBER" });
        expect((await capture(() => transfer(service)))?.statusCode).toBe(403);
    });

    it("대상이 활성 MEMBER 가 아니면 400", async () => {
        const { service } = build({ roomRole: "OWNER", targetRoomRole: null });
        expect((await capture(() => transfer(service)))?.statusCode).toBe(400);
    });
});

// 나가기 / 마지막 나감 시 방 삭제
describe("팀 채팅방 나가기", () => {
    const leave = (service: ReturnType<typeof build>["service"]) =>
        service.leaveRoomOrThrow({ chatId: "c1", currentUserId: "u1" });

    it("참여자는 나갈 수 있다", async () => {
        const { service, leaves } = build({ roomRole: "MEMBER" });
        await leave(service);
        expect(leaves).toEqual(["u1"]);
    });

    it("방장은 나갈 수 없다", async () => {
        const { service } = build({ roomRole: "OWNER" });
        const err = await capture(() => leave(service));
        expect(err?.statusCode).toBe(403);
        expect(err?.message).toContain("양도");
    });

    it("참여자가 아니면 403", async () => {
        const { service } = build({ roomRole: null });
        expect((await capture(() => leave(service)))?.statusCode).toBe(403);
    });

    it("마지막 나감이면 deleted:true 를 돌려준다", async () => {
        const { service, setLastLeaveDeleted } = build({ roomRole: "MEMBER" });
        setLastLeaveDeleted(true);
        const result = await leave(service);
        expect(result).toEqual({ deleted: true });
    });
});

// 프로젝트 강퇴 훅
describe("onProjectMemberRemoved", () => {
    it("MEMBER 인 방에서는 그냥 leave 한다", async () => {
        const { service, leaves } = build({
            activeRooms: [{ chatId: "c1", memberRole: "MEMBER" }],
        });
        const results = await service.onProjectMemberRemoved("p1", "removed");
        expect(leaves).toEqual(["removed"]);
        expect(results[0]).toEqual({ chatId: "c1", wasOwner: false, successorId: null, chatDeleted: false });
    });

    it("OWNER 인 방은 가장 오래된 다른 참여자에게 양도 후 나간다", async () => {
        const { service, transfers } = build({
            activeRooms: [{ chatId: "c1", memberRole: "OWNER" }],
            oldest: "successor",
        });
        const results = await service.onProjectMemberRemoved("p1", "removed");
        expect(transfers).toEqual([{ chatId: "c1", oldOwnerId: "removed", newOwnerId: "successor" }]);
        expect(results[0]?.wasOwner).toBe(true);
        expect(results[0]?.successorId).toBe("successor");
    });

    it("OWNER 인데 잔여자가 없으면 leaveRoomAndMaybeDeleteChat 로 방 삭제", async () => {
        const { service, leaves } = build({
            activeRooms: [{ chatId: "c1", memberRole: "OWNER" }],
            oldest: null,
        });
        const results = await service.onProjectMemberRemoved("p1", "removed");
        expect(leaves).toEqual(["removed"]);
        expect(results[0]?.wasOwner).toBe(true);
        expect(results[0]?.successorId).toBe(null);
    });
});

// 명세 BR-D2-04 — 팀 채팅방은 공용이라 프로젝트 단위로 센다.
describe("팀 채팅방 개수 제한", () => {
    const create = (service: ReturnType<typeof build>["service"]) =>
        service.createRoom({ projectId: "p1", name: "일반", memberIds: ["m1"], currentUserId: "u1" });

    it("한도 미만이면 만들어진다", async () => {
        const { service, createdRooms } = build({ roomCount: MAX_TEAM_CHAT_ROOMS - 1 });
        await create(service);
        expect(createdRooms).toHaveLength(1);
    });

    it("한도에 닿으면 409", async () => {
        const { service } = build({ roomCount: MAX_TEAM_CHAT_ROOMS });
        expect((await capture(() => create(service)))?.statusCode).toBe(409);
    });

    it("프로젝트 멤버가 아니면 개수 검사 전에 403", async () => {
        const { service } = build({ roomCount: MAX_TEAM_CHAT_ROOMS, projectRole: null });
        expect((await capture(() => create(service)))?.statusCode).toBe(403);
    });

    it("한도는 명세 값 50 이다", () => {
        expect(MAX_TEAM_CHAT_ROOMS).toBe(50);
    });
});
