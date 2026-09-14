import { describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { MAX_TEAM_CHAT_ROOMS, TeamChatService } from "./team-chat.service.js";

// 가짜 저장소로 DB 없이 돌린다. project.service.test.ts 와 같은 방식이다.
const build = (opts: {
  room?: { projectId: string } | null;
  projectRole?: "OWNER" | "MEMBER" | null;
  roomRole?: "OWNER" | "ADMIN" | "MEMBER" | null;
  takenNames?: string[];
  roomCount?: number;
}) => {
  const createdRooms: unknown[] = [];
  const renamed: string[] = [];
  const deleted: string[] = [];

  const repository = {
    countRooms: async () => opts.roomCount ?? 0,
    createRoom: async (params: unknown) => {
      createdRooms.push(params);
      return {} as never;
    },
    getRoom: async () => (opts.room === undefined ? { projectId: "p1" } : opts.room),
    listRoomNames: async () => opts.takenNames ?? [],
    renameRoom: async (_id: string, name: string) => {
      renamed.push(name);
      return { id: "c1", name } as never;
    },
    deleteRoom: async (chatId: string) => {
      deleted.push(chatId);
      return true;
    },
    getParticipantRole: async () => (opts.roomRole === undefined ? "OWNER" : opts.roomRole),
  };

  const projectRepository = {
    existsById: async () => true,
    findMemberRole: async () => (opts.projectRole === undefined ? "MEMBER" : opts.projectRole),
  };

  const service = new TeamChatService(repository as never, projectRepository as never);
  return { service, renamed, deleted, createdRooms };
};

const capture = async (fn: () => Promise<unknown>): Promise<HttpError | null> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error : null;
  }
};

// 명세 D-3 / BR-D3-02 · BR-D3-04
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

  it("같은 이름이 있으면 (2) 가 붙는다", async () => {
    const { service, renamed } = build({ takenNames: ["공지"] });

    await rename(service);

    expect(renamed).toEqual(["공지 (2)"]);
  });

  it("최종 이름을 돌려준다", async () => {
    // "(N)"이 붙었는지 화면이 알아야 사용자에게 안내할 수 있다(BR-D3-04).
    const { service } = build({ takenNames: ["공지"] });

    const updated = await rename(service);

    expect((updated as { name: string }).name).toBe("공지 (2)");
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

  it("프로젝트 OWNER 라도 방 OWNER 가 아니면 403", async () => {
    // 권한 기준이 프로젝트가 아니라 방이다. 남의 방을 지울 수 없다.
    const { service } = build({ projectRole: "OWNER", roomRole: "MEMBER" });

    expect((await capture(() => remove(service)))?.statusCode).toBe(403);
  });

  it("막힐 때 삭제가 실행되지 않는다", async () => {
    const { service, deleted } = build({ roomRole: "MEMBER" });

    await capture(() => remove(service));

    expect(deleted).toHaveLength(0);
  });

  it("없는 방이면 404", async () => {
    const { service } = build({ room: null });

    expect((await capture(() => remove(service)))?.statusCode).toBe(404);
  });
});

// 명세 BR-D2-04 — 팀 채팅방은 공용이라 프로젝트 단위로 센다.
describe("팀 채팅방 개수 제한", () => {
  const create = (service: ReturnType<typeof build>["service"]) =>
    service.createRoom({ projectId: "p1", name: "일반", currentUserId: "u1" });

  it("한도 미만이면 만들어진다", async () => {
    const { service, createdRooms } = build({ roomCount: MAX_TEAM_CHAT_ROOMS - 1 });

    await create(service);

    expect(createdRooms).toHaveLength(1);
  });

  it("한도에 닿으면 409", async () => {
    const { service } = build({ roomCount: MAX_TEAM_CHAT_ROOMS });

    expect((await capture(() => create(service)))?.statusCode).toBe(409);
  });

  it("막힐 때 채팅방이 만들어지지 않는다", async () => {
    const { service, createdRooms } = build({ roomCount: MAX_TEAM_CHAT_ROOMS });

    await capture(() => create(service));

    expect(createdRooms).toHaveLength(0);
  });

  it("프로젝트 멤버가 아니면 개수 검사 전에 403", async () => {
    // 403 대신 409가 나오면 남의 프로젝트에 방이 몇 개인지 알려주는 셈이 된다.
    const { service } = build({ roomCount: MAX_TEAM_CHAT_ROOMS, projectRole: null });

    expect((await capture(() => create(service)))?.statusCode).toBe(403);
  });

  it("한도는 명세 값 50 이다", () => {
    expect(MAX_TEAM_CHAT_ROOMS).toBe(50);
  });
});
