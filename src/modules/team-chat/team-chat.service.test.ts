import { describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { TeamChatService } from "./team-chat.service.js";

// 가짜 저장소로 DB 없이 돌린다. project.service.test.ts 와 같은 방식이다.
const build = (opts: {
  room?: { projectId: string } | null;
  projectRole?: "OWNER" | "MEMBER" | null;
  roomRole?: "OWNER" | "ADMIN" | "MEMBER" | null;
  takenNames?: string[];
}) => {
  const renamed: string[] = [];
  const deleted: string[] = [];
  const addedParticipants: string[] = [];

  const repository = {
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
    addParticipant: async (p: { userId: string }) => {
      addedParticipants.push(p.userId);
      return {} as never;
    },
  };

  const projectRepository = {
    findMemberRole: async () => (opts.projectRole === undefined ? "MEMBER" : opts.projectRole),
  };

  const service = new TeamChatService(repository as never, projectRepository as never);
  return { service, renamed, deleted, addedParticipants };
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

// 명세 D-5 — 참여자 추가 권한을 프로젝트 OWNER 전용에서 방 참여자 누구나로 넓힌다.
describe("팀 채팅방 참여자 추가", () => {
  const add = (service: ReturnType<typeof build>["service"], userId = "u2") =>
    service.addParticipant({ chatId: "c1", userId, currentUserId: "u1" });

  it("방 참여자는 추가할 수 있다", async () => {
    const { service, addedParticipants } = build({ roomRole: "MEMBER" });

    await add(service);

    expect(addedParticipants).toEqual(["u2"]);
  });

  it("프로젝트 OWNER 가 아니어도 방 참여자면 된다", async () => {
    // 이 변경의 핵심이다. 전에는 프로젝트 OWNER 만 가능했다.
    const { service, addedParticipants } = build({ roomRole: "MEMBER", projectRole: "MEMBER" });

    await add(service);

    expect(addedParticipants).toEqual(["u2"]);
  });

  it("방 참여자가 아니면 403", async () => {
    // 프로젝트 OWNER 라도 자기가 없는 방에는 남을 넣을 수 없다.
    const { service } = build({ roomRole: null, projectRole: "OWNER" });

    expect((await capture(() => add(service)))?.statusCode).toBe(403);
  });

  it("대상이 프로젝트 멤버가 아니면 403", async () => {
    const { service } = build({ roomRole: "MEMBER", projectRole: null });

    expect((await capture(() => add(service)))?.statusCode).toBe(403);
  });

  it("막힐 때 추가가 실행되지 않는다", async () => {
    const { service, addedParticipants } = build({ roomRole: null });

    await capture(() => add(service));

    expect(addedParticipants).toHaveLength(0);
  });
});

