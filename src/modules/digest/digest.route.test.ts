import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerErrorHandler } from "../../common/error-handler.js";
import { registerDigestRoutes } from "./digest.route.js";
import type { DigestRepository } from "./digest.repository.js";

const meId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const sourceChatId = "00000000-0000-4000-8000-000000000010";
const targetChatId = "00000000-0000-4000-8000-000000000011";
const digestMessageId = "00000000-0000-4000-8000-000000000020";
const answer1 = "00000000-0000-4000-8000-000000000030";
const answer2 = "00000000-0000-4000-8000-000000000031";

const authRepository = {
  findById: async (id: string) => ({
    id,
    email: "me@test.com",
    passwordHash: "unused",
    name: "Me",
    avatarUrl: null,
    tokenVersion: 0,
  }),
} as never;

const bearer = `Bearer ${jwt.sign({ sub: meId, tokenVersion: 0 }, "test-secret")}`;

type EmitLog = Array<{ event: string; payload: unknown; room: string }>;

const buildApp = (
  repository: Partial<DigestRepository>,
  options?: { openAi?: boolean; onEmit?: (log: EmitLog[number]) => void }
) => {
  const emitLog: EmitLog = [];
  const app = Fastify();
  registerErrorHandler(app);

  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        const entry = { event, payload, room };
        emitLog.push(entry);
        options?.onEmit?.(entry);
      },
    }),
  } as unknown as import("socket.io").Server;

  const openAiClient = options?.openAi
    ? {
        streamChat: async function* () {
          yield "hello";
        },
      }
    : null;

  return {
    app,
    emitLog,
    register: () =>
      registerDigestRoutes(app, {
        repository: repository as DigestRepository,
        authRepository,
        openAiClient,
        io,
      }),
  };
};

describe("digest routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  describe("POST share", () => {
    it("성공 시 스냅샷을 저장하고 소켓으로 브로드캐스트한다", async () => {
      const insertSharedMessageWithSnapshot = vi.fn().mockResolvedValue({
        id: digestMessageId,
        chat_id: targetChatId,
        user_id: meId,
        role: "ASSISTANT",
        content: "본문",
        status: "COMPLETE",
        sources: [],
        created_at: "2026-09-20T00:00:00.000Z",
        deleted_at: null,
      });
      const repo: Partial<DigestRepository> = {
        getChatOwnership: vi.fn().mockResolvedValue({
          id: sourceChatId,
          project_id: projectId,
          created_by: meId,
        }),
        canShareTo: vi.fn().mockResolvedValue(true),
        findQaSets: vi.fn().mockResolvedValue([
          { answerMessageId: answer1, answer: "A1", questionMessageId: "q1", question: "Q1", citedChunks: [] },
          { answerMessageId: answer2, answer: "A2", questionMessageId: "q2", question: "Q2", citedChunks: [] },
        ]),
        insertSharedMessageWithSnapshot,
      };
      const { app, emitLog, register } = buildApp(repo, { openAi: true });
      apps.push(app);
      await register();

      const res = await app.inject({
        method: "POST",
        url: `/api/chats/me/${sourceChatId}/digests/share`,
        headers: { authorization: bearer },
        payload: {
          target_chat_id: targetChatId,
          message_ids: [answer1, answer2],
          note: "확인 부탁",
          content: "정리 결과",
          sources: [],
        },
      });

      expect(res.statusCode).toBe(201);
      expect(insertSharedMessageWithSnapshot).toHaveBeenCalledTimes(1);
      const call = insertSharedMessageWithSnapshot.mock.calls[0]![0];
      expect(call.sourceMessageIds).toEqual([answer1, answer2]);
      expect(call.snapshot.note).toBe("확인 부탁");
      expect(call.snapshot.pairs).toHaveLength(2);

      const emit = emitLog.find((e) => e.event === "team:message:receive");
      expect(emit?.room).toBe(targetChatId);
    });

    it("message_ids 가 없으면 400", async () => {
      const { app, register } = buildApp({}, { openAi: true });
      apps.push(app);
      await register();
      const res = await app.inject({
        method: "POST",
        url: `/api/chats/me/${sourceChatId}/digests/share`,
        headers: { authorization: bearer },
        payload: { target_chat_id: targetChatId, content: "x" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("일부 message_id 가 유효하지 않으면 400 DIGEST_MESSAGE_UNAVAILABLE", async () => {
      const repo: Partial<DigestRepository> = {
        getChatOwnership: vi.fn().mockResolvedValue({
          id: sourceChatId,
          project_id: projectId,
          created_by: meId,
        }),
        canShareTo: vi.fn().mockResolvedValue(true),
        findQaSets: vi.fn().mockResolvedValue([
          { answerMessageId: answer1, answer: "A1", questionMessageId: null, question: "", citedChunks: [] },
        ]),
      };
      const { app, register } = buildApp(repo, { openAi: true });
      apps.push(app);
      await register();

      const res = await app.inject({
        method: "POST",
        url: `/api/chats/me/${sourceChatId}/digests/share`,
        headers: { authorization: bearer },
        payload: {
          target_chat_id: targetChatId,
          message_ids: [answer1, answer2],
          content: "x",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details?.code).toBe("DIGEST_MESSAGE_UNAVAILABLE");
    });
  });
});

// otherId 는 뒤 커밋의 delete/recent 케이스에서 재사용된다.
void otherId;
