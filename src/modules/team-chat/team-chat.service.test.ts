import { describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { MAX_TEAM_CHAT_ROOMS, TeamChatService } from "./team-chat.service.js";

// 가짜 저장소로 DB 없이 돌린다. project.service.test.ts 와 같은 방식이다.
const build = (opts: { roomCount?: number; role?: "OWNER" | "MEMBER" | null }) => {
  const createdRooms: unknown[] = [];

  const repository = {
    countRooms: async () => opts.roomCount ?? 0,
    createRoom: async (params: unknown) => {
      createdRooms.push(params);
      return {} as never;
    },
  };

  const projectRepository = {
    existsById: async () => true,
    findMemberRole: async () => (opts.role === undefined ? "MEMBER" : opts.role),
  };

  const service = new TeamChatService(repository as never, projectRepository as never);
  return { service, createdRooms };
};

const capture = async (fn: () => Promise<unknown>): Promise<HttpError | null> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error : null;
  }
};

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
    const { service } = build({ roomCount: MAX_TEAM_CHAT_ROOMS, role: null });

    expect((await capture(() => create(service)))?.statusCode).toBe(403);
  });

  it("한도는 명세 값 50 이다", () => {
    expect(MAX_TEAM_CHAT_ROOMS).toBe(50);
  });
});
