import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it } from "vitest";
import { registerChatRoutes } from "./chat.route.js";

const chatId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const sources = [
  {
    filePath: "src/middleware/ssrSafe.ts",
    startLine: 1,
    endLine: 25,
    snippet: "SSR 상태 변경을 막습니다.",
    relevanceScore: 0.91,
  },
];

describe("chat message sources route", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("persists streamed sources and returns them from the message list", async () => {
    let savedSources: typeof sources = [];
    const app = Fastify();
    apps.push(app);
    const chat = {
      id: chatId,
      project_id: "00000000-0000-4000-8000-000000000003",
      created_by: userId,
      name: "테스트",
      chat_type: "PERSONAL" as const,
      created_at: "2026-09-16T00:00:00.000Z",
    };

    await registerChatRoutes(app, {
      repository: {
        getChatById: async () => chat,
        insertMessage: async (input: { role: string }) => ({ id: input.role === "USER" ? "u1" : "a1" }),
        finalizeMessage: async (input: { sources?: typeof sources }) => {
          savedSources = input.sources ?? [];
        },
        paginateMessages: async () => [
          {
            id: "a1",
            chat_id: chatId,
            user_id: null,
            role: "ASSISTANT",
            content: "답변",
            status: "COMPLETE",
            sources: savedSources,
            created_at: "2026-09-16T00:00:01.000Z",
          },
        ],
      } as never,
      projectRepository: { findRunningSyncJobByProject: async () => null } as never,
      authRepository: {
        findById: async () => ({
          id: userId,
          email: "test@example.com",
          passwordHash: "unused",
          name: "Test",
          avatarUrl: null,
          tokenVersion: 0,
        }),
      } as never,
      streamAssistant: async function* () {
        yield "답변";
        yield { type: "sources" as const, sources };
      },
    });

    const authorization = `Bearer ${jwt.sign({ sub: userId, tokenVersion: 0 }, "test-secret")}`;
    const stream = await app.inject({
      method: "POST",
      url: `/api/chats/me/${chatId}/messages`,
      headers: { authorization },
      payload: { content: "질문" },
    });
    expect(stream.statusCode).toBe(200);
    expect(savedSources).toEqual(sources);

    const messages = await app.inject({
      method: "GET",
      url: `/api/chats/me/${chatId}/messages`,
      headers: { authorization },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().data[0].sources).toEqual(sources);
  });
});
