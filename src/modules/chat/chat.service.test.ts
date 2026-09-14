import { describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { ChatService } from "./chat.service.js";

type ChatType = "PERSONAL" | "TEAM";

// 가짜 저장소로 DB 없이 돌린다. project.service.test.ts 와 같은 방식이다.
const build = (opts: {
  chatType?: ChatType;
  createdBy?: string;
  isMember?: boolean;
  runningJob?: { progress: number } | null;
}) => {
  const inserted: unknown[] = [];
  const askedProjectIds: string[] = [];

  const repository = {
    // 반환 모양은 chat.repository.ts 의 getChatById 를 그대로 따랐다.
    getChatById: async () => ({
      id: "c1",
      project_id: "p1",
      created_by: opts.createdBy ?? "u1",
      name: "테스트 채팅",
      chat_type: opts.chatType ?? ("PERSONAL" as ChatType),
      created_at: "2026-09-14T00:00:00.000Z",
    }),
    isActiveMember: async () => opts.isMember ?? true,
    insertMessage: async (params: unknown) => {
      inserted.push(params);
      return { id: "m1" } as never;
    },
  };

  const projectRepository = {
    findRunningSyncJobByProject: async (projectId: string) => {
      askedProjectIds.push(projectId);
      return (opts.runningJob ?? null) as never;
    },
  };

  const service = new ChatService(repository as never, projectRepository as never);
  return { service, inserted, askedProjectIds };
};

const send = (service: ChatService, userId = "u1") =>
  service.sendUserMessage({ chatId: "c1", userId, content: "이 함수 어디서 호출돼?" });

const capture = async (fn: () => Promise<unknown>): Promise<HttpError | null> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error : null;
  }
};

describe("동기화 중 질문 차단 (ADR-005)", () => {
  it("동기화 중이면 409 SYNC_IN_PROGRESS 로 막는다", async () => {
    const { service } = build({ runningJob: { progress: 42 } });

    const error = await capture(() => send(service));

    expect(error?.statusCode).toBe(409);
    expect(error?.details).toMatchObject({ code: "SYNC_IN_PROGRESS", progress: 42 });
  });

  it("막힐 때 메시지를 저장하지 않는다", async () => {
    const { service, inserted } = build({ runningJob: { progress: 42 } });

    await capture(() => send(service));

    // 답 없는 유령 메시지가 남으면 안 된다. 가드가 insertMessage 뒤로 가면 여기서 잡힌다.
    expect(inserted).toHaveLength(0);
  });

  it("동기화 중이 아니면 평소대로 저장한다", async () => {
    const { service, inserted } = build({ runningJob: null });

    await send(service);

    expect(inserted).toHaveLength(1);
  });

  it("progress 가 0이어도 막는다", async () => {
    // 막 시작한 동기화. if (job?.progress) 로 쓰면 0이 거짓이라 통과해버린다.
    const { service } = build({ runningJob: { progress: 0 } });

    expect((await capture(() => send(service)))?.statusCode).toBe(409);
  });

  it("채팅방이 속한 프로젝트로 조회한다", async () => {
    const { service, askedProjectIds } = build({ runningJob: null });

    await send(service);

    expect(askedProjectIds).toEqual(["p1"]);
  });

  it("권한이 없으면 동기화 검사 전에 403 이다", async () => {
    // 팀 채팅 비참여자. 403 대신 409가 나오면 방의 존재와 동기화 상태를 남에게 알려주는 셈이다.
    const { service, askedProjectIds } = build({
      chatType: "TEAM",
      isMember: false,
      runningJob: { progress: 42 },
    });

    expect((await capture(() => send(service)))?.statusCode).toBe(403);
    expect(askedProjectIds).toHaveLength(0);
  });
});
