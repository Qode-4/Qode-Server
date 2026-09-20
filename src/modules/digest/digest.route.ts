import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import type { SourceInfo } from "../rag/rag.types.js";
import type { DigestRepository } from "./digest.repository.js";
import { DigestService, defaultTitle } from "./digest.service.js";
import {
  chatIdParamSchema,
  messageItemJsonSchema,
  previewDigestBodySchema,
  shareDigestBodySchema,
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
};

export const registerDigestRoutes = async (app: FastifyInstance, deps: RouteDeps) => {
  if (!deps.repository) throw new HttpError(503, "Digest repository is unavailable");

  const service = new DigestService(deps.repository, deps.openAiClient);
  const authService = new AuthService(deps.authRepository);

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
            title: { type: "string", minLength: 1, maxLength: 100 },
            content: { type: "string", minLength: 1, maxLength: 50000 },
            sources: { type: "array", maxItems: 100 },
          },
          required: ["target_chat_id", "content"],
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
      });

      return reply.status(201).send({
        ok: true,
        data: { ...message, sources: message.sources ?? [] },
      });
    }
  );
};