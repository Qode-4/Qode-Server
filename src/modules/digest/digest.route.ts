import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Server as SocketIoServer } from "socket.io";
import { HttpError } from "../../common/http-error.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import type { SourceInfo } from "../rag/rag.types.js";
import type { DigestRepository } from "./digest.repository.js";
import { DigestService, defaultTitle } from "./digest.service.js";
import {
  chatIdParamSchema,
  digestMessageIdParamSchema,
  digestSourceJsonSchema,
  messageItemJsonSchema,
  previewDigestBodySchema,
  recentShareItemJsonSchema,
  recentShareQuerySchema,
  shareDigestBodySchema,
  teamMessageParamSchema,
} from "./digest.schema.js";
import { streamSse } from "../../common/sse.js";

type RouteDeps = {
  repository: DigestRepository;
  authRepository: AuthRepository;
  openAiClient: {
    streamChat: (
      messages: { role: "system" | "user" | "assistant"; content: string }[],
      options?: { signal?: AbortSignal }
    ) => AsyncIterable<string>;
  } | null;
  io?: SocketIoServer | null;
};

export const registerDigestRoutes = async (app: FastifyInstance, deps: RouteDeps) => {
  if (!deps.repository) throw new HttpError(503, "Digest repository is unavailable");

  const service = new DigestService(deps.repository, deps.openAiClient);
  const authService = new AuthService(deps.authRepository);
  const io = deps.io ?? null;

  const getRequestUserId = async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Unauthorized");
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) throw new HttpError(401, "Unauthorized");
    const me = await authService.getMe(token);
    return me.id;
  };

  // 1) 미리보기 생성 (SSE). 서버에 저장하지 않는다.
  //    프론트는 token 을 모아 화면에 띄우고, sources 를 보관했다가 share 에 그대로 실어 보낸다.
  app.post(
    "/api/chats/me/:id/digests/preview",
    {
      schema: {
        tags: ["digest"],
        summary: "Stream a digest preview from selected Q&A messages (not persisted)",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            message_ids: {
              type: "array",
              items: { type: "string", format: "uuid" },
              minItems: 1,
              maxItems: 20,
            },
            note: { type: "string", maxLength: 500 },
          },
          required: ["message_ids"],
        },
        produces: ["text/event-stream"],
        response: { 200: { description: "Server-sent events stream", type: "string" } },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const body = previewDigestBodySchema.parse(request.body);
      const userId = await getRequestUserId(request);

      // 스트림을 열기 전에 끝낸다. 헤더가 나간 뒤에는 상태 코드를 바꿀 수 없다.
      const { sets } = await service.prepare({
        chatId: params.id,
        userId,
        messageIds: body.message_ids,
      });

      await streamSse(request, reply, async ({ send, signal }) => {
        send("start", { title: defaultTitle(sets), messageIds: body.message_ids });

        for await (const chunk of service.stream({ sets, note: body.note, signal })) {
          if (chunk.type === "token") {
            send("token", { token: chunk.content });
            continue;
          }
          if (chunk.type === "sources") {
            send("sources", { sources: chunk.sources });
          }
        }

        if (!signal.aborted) send("done", {});
      });
    }
  );

  // 2) 확인 → 팀 채팅 게시
  app.post(
    "/api/chats/me/:id/digests/share",
    {
      schema: {
        tags: ["digest"],
        summary: "Post a reviewed digest to a team chat",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            target_chat_id: { type: "string", format: "uuid" },
            message_ids: {
              type: "array",
              items: { type: "string", format: "uuid" },
              minItems: 1,
              maxItems: 20,
            },
            note: { type: "string", maxLength: 500 },
            title: { type: "string", minLength: 1, maxLength: 100 },
            content: { type: "string", minLength: 1, maxLength: 50000 },
            sources: { type: "array", maxItems: 100 },
          },
          required: ["target_chat_id", "message_ids", "content"],
        },
        response: {
          201: {
            type: "object",
            properties: { ok: { type: "boolean" }, data: messageItemJsonSchema },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const body = shareDigestBodySchema.parse(request.body);
      const userId = await getRequestUserId(request);

      const message = await service.share({
        sourceChatId: params.id,
        targetChatId: body.target_chat_id,
        userId,
        content: body.title ? `## ${body.title}\n\n${body.content}` : body.content,
        sources: body.sources as SourceInfo[],
        messageIds: body.message_ids,
        note: body.note,
      });

      // 팀채팅 룸에 실시간 반영. socket.server 의 team:message:receive 계약과 맞춘다.
      // 실패해도 API 응답에는 영향 없다 — 클라이언트는 응답으로도 새 카드를 받는다.
      if (io) {
        try {
          io.to(message.chat_id).emit("team:message:receive", {
            ...message,
            sources: message.sources ?? [],
          });
        } catch (err) {
          request.log.warn({ err }, "digest share socket emit failed");
        }
      }

      return reply.status(201).send({
        ok: true,
        data: { ...message, sources: message.sources ?? [] },
      });
    }
  );

  // 3) 중복 안내 — 같은 개인채팅에서 같은 message_ids 조합을 최근 30일 안에 이미 공유했는가.
  app.get(
    "/api/chats/me/:id/digests/recent",
    {
      schema: {
        tags: ["digest"],
        summary: "List recent shares matching an exact set of message ids (dedup guard)",
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: { message_ids: { type: "string" } },
          required: ["message_ids"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: recentShareItemJsonSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const query = recentShareQuerySchema.parse(request.query);
      const userId = await getRequestUserId(request);

      const data = await service.getRecentShares({
        sourceChatId: params.id,
        userId,
        messageIds: query.message_ids,
      });
      return reply.send({ ok: true, data });
    }
  );

  // 4) 원본 대화 열기 — 팀채팅 카드에서 공유된 pair 스냅샷을 조회한다.
  app.get(
    "/api/digests/:digestMessageId/source",
    {
      schema: {
        tags: ["digest"],
        summary: "Get the original Q&A pair snapshot backing a shared digest card",
        params: {
          type: "object",
          properties: { digestMessageId: { type: "string", format: "uuid" } },
          required: ["digestMessageId"],
        },
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" }, data: digestSourceJsonSchema },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = digestMessageIdParamSchema.parse(request.params);
      const userId = await getRequestUserId(request);
      const data = await service.getShareSource({
        digestMessageId: params.digestMessageId,
        userId,
      });
      return reply.send({ ok: true, data });
    }
  );

  // 5) 공유 카드 회수 — 소프트 삭제 + 실시간 브로드캐스트.
  app.delete(
    "/api/chats/team/:chatId/messages/:messageId",
    {
      schema: {
        tags: ["digest"],
        summary: "Soft-delete a shared digest card (owner of share or chat OWNER only)",
        params: {
          type: "object",
          properties: {
            chatId: { type: "string", format: "uuid" },
            messageId: { type: "string", format: "uuid" },
          },
          required: ["chatId", "messageId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: { alreadyDeleted: { type: "boolean" } },
                required: ["alreadyDeleted"],
              },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = teamMessageParamSchema.parse(request.params);
      const userId = await getRequestUserId(request);

      const { alreadyDeleted } = await service.deleteSharedMessage({
        chatId: params.chatId,
        messageId: params.messageId,
        userId,
      });

      if (!alreadyDeleted && io) {
        try {
          io.to(params.chatId).emit("team:message:deleted", {
            chatId: params.chatId,
            messageId: params.messageId,
          });
        } catch (err) {
          request.log.warn({ err }, "digest delete socket emit failed");
        }
      }

      return reply.send({ ok: true, data: { alreadyDeleted } });
    }
  );
};