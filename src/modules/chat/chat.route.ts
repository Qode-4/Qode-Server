import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { env } from "../../config/env.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import type { SourceInfo } from "../rag/rag.types.js";
import { createChatRepository } from "./chat.repository.js";
import {
  chatIdParamSchema,
  createChatBodySchema,
  listMyChatsQuerySchema,
  listMessagesQuerySchema,
  listPromptMessagesQuerySchema,
  renameChatBodySchema,
  sendUserMessageBodySchema,
} from "./chat.schema.js";
import type { ProjectRepository } from "../project/project.repository.js";
import { ChatService } from "./chat.service.js";

type ChatRepository = ReturnType<typeof createChatRepository>;

type StreamAssistantInput = {
  chatId: string;
  userId: string;
  content: string;
};

type StreamAssistantOutput = string | { type: "sources"; sources: SourceInfo[] };

type RouteDeps = {
  repository: ChatRepository;
  projectRepository: ProjectRepository;
  authRepository: AuthRepository;
  streamAssistant?: (input: StreamAssistantInput) => AsyncIterable<StreamAssistantOutput>;
};

type ChatRow = {
  id: string;
  project_id: string;
  created_by: string;
  name: string;
  chat_type: "PERSONAL" | "TEAM";
  created_at: string;
};

type MessageRow = {
  id: string;
  chat_id: string;
  user_id: string | null;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  status: "COMPLETE" | "STREAMING" | "FAILED";
  sources: SourceInfo[];
  created_at: string;
};

export const registerChatRoutes = async (app: FastifyInstance, deps: RouteDeps) => {
  if (!deps.repository) {
    throw new HttpError(503, "Chat repository is unavailable");
  }

  const service = new ChatService(deps.repository, deps.projectRepository);
  const authService = new AuthService(deps.authRepository);

  const getRequestUserId = async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new HttpError(401, "Unauthorized");
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new HttpError(401, "Unauthorized");
    }

    const me = await authService.getMe(token);
    return me.id;
  };
  const chatItemSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      project_id: { type: "string", format: "uuid" },
      created_by: { type: "string", format: "uuid" },
      name: { type: "string" },
      chat_type: { type: "string", enum: ["PERSONAL", "TEAM"] },
      created_at: { type: "string", format: "date-time" },
    },
    required: ["id", "project_id", "created_by", "name", "chat_type", "created_at"],
  } as const;

  const messageItemSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      chat_id: { type: "string", format: "uuid" },
      user_id: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
      role: { type: "string", enum: ["USER", "ASSISTANT", "SYSTEM"] },
      content: { type: "string" },
      status: { type: "string", enum: ["COMPLETE", "STREAMING", "FAILED"] },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            startLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
            endLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
            snippet: { type: "string" },
            relevanceScore: { type: "number" },
          },
          required: ["filePath", "startLine", "endLine", "snippet", "relevanceScore"],
        },
      },
      created_at: { type: "string", format: "date-time" },
    },
    required: ["id", "chat_id", "user_id", "role", "content", "status", "sources", "created_at"],
  } as const;

  const promptMessageItemSchema = {
    type: "object",
    properties: {
      role: { type: "string", enum: ["USER", "ASSISTANT", "SYSTEM"] },
      content: { type: "string" },
    },
    required: ["role", "content"],
  } as const;

  const mapChat = (row: ChatRow) => ({
    id: row.id,
    project_id: row.project_id,
    created_by: row.created_by,
    name: row.name,
    chat_type: row.chat_type,
    created_at: row.created_at,
  });

  const mapMessage = (row: MessageRow) => ({
    id: row.id,
    chat_id: row.chat_id,
    user_id: row.user_id,
    role: row.role,
    content: row.content,
    status: row.status,
    sources: row.sources ?? [],
    created_at: row.created_at,
  });

  app.get(
    "/api/chats/me",
    {
      schema: {
        tags: ["chat"],
        summary: "List my chats",
        querystring: {
          type: "object",
          properties: {
            project_id: { type: "string", format: "uuid" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["project_id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: chatItemSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const query = listMyChatsQuerySchema.parse(request.query);
      const userId = await getRequestUserId(request);
      const data = await service.listMyChats({
        projectId: query.project_id,
        userId,
        limit: query.limit,
      });
      return reply.send({ ok: true, data: data.map(mapChat) });
    }
  );

  app.post(
    "/api/chats/me",
    {
      schema: {
        tags: ["chat"],
        summary: "Create personal chat",
        body: {
          type: "object",
          properties: {
            project_id: { type: "string", format: "uuid" },
            chat_type: { type: "string", enum: ["PERSONAL"] },
            name: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["project_id", "chat_type", "name"],
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: chatItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const body = createChatBodySchema.parse(request.body);
      const userId = await getRequestUserId(request);
      if (body.chat_type !== "PERSONAL") {
        throw new HttpError(400, "Only PERSONAL chat is supported now");
      }

      const data = await service.createPersonalChat({
        projectId: body.project_id,
        userId,
        name: body.name,
      });
      return reply.status(201).send({ ok: true, data: mapChat(data as ChatRow) });
    }
  );

  app.patch(
    "/api/chats/me/:id",
    {
      schema: {
        tags: ["chat"],
        summary: "Rename personal chat",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 20 },
          },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: chatItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const body = renameChatBodySchema.parse(request.body);
      const userId = await getRequestUserId(request);
      const data = await service.renameMyChat({
        chatId: params.id,
        userId,
        name: body.name,
      });
      return reply.send({ ok: true, data: mapChat(data as ChatRow) });
    }
  );

  app.delete(
    "/api/chats/me/:id",
    {
      schema: {
        tags: ["chat"],
        summary: "Delete personal chat",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        response: {
          204: {
            description: "No content",
            type: "null",
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const userId = await getRequestUserId(request);
      await service.deleteMyChat({
        chatId: params.id,
        userId,
      });
      return reply.status(204).send();
    }
  );

  app.post(
    "/api/chats/me/:id/messages",
    {
      schema: {
        tags: ["chat"],
        summary: "Send user message and stream assistant response",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1, maxLength: 4000 },
          },
          required: ["content"],
        },
        produces: ["text/event-stream"],
        response: {
          200: {
            description: "Server-sent events stream",
            type: "string",
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const body = sendUserMessageBodySchema.parse(request.body);
      const userId = await getRequestUserId(request);

      const origin = request.headers.origin;
      if (origin && env.CORS_ALLOWED_ORIGINS.includes(origin)) {
        reply.raw.setHeader("Vary", "Origin");
        reply.raw.setHeader("Access-Control-Allow-Origin", origin);
        reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      }
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");

      const sendEvent = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let assistantMessageId: string | null = null;

      try {
        const userMessage = await service.sendUserMessage({
          chatId: params.id,
          userId,
          content: body.content,
        });

        const assistantMessage = await service.startAssistantMessage({
          chatId: params.id,
          userId,
        });
        assistantMessageId = assistantMessage.id;

        sendEvent("start", {
          chatId: params.id,
          userMessageId: userMessage.id,
          assistantMessageId,
        });

        if (!deps.streamAssistant) {
          throw new HttpError(501, "AI streaming provider is not configured");
        }

        let fullContent = "";
        let sources: SourceInfo[] = [];
        for await (const chunk of deps.streamAssistant({
          chatId: params.id,
          userId,
          content: body.content,
        })) {
          if (typeof chunk === "string") {
            fullContent += chunk;
            sendEvent("token", { token: chunk });
            continue;
          }

          if (chunk.type === "sources") {
            sources = chunk.sources;
            sendEvent("sources", { sources: chunk.sources });
          }
        }

        if (!assistantMessageId) {
          throw new HttpError(500, "Assistant message id is missing");
        }

        await service.finalizeAssistantMessage({
          messageId: assistantMessageId,
          content: fullContent,
          sources,
        });
        sendEvent("done", { assistantMessageId });
      } catch (error) {
        if (assistantMessageId) {
          const partial = error instanceof Error ? error.message : undefined;
          await service.failAssistantMessage({
            messageId: assistantMessageId,
            contentPartial: partial,
          });
        }

        const message =
          error instanceof HttpError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unexpected streaming error";
        // HttpError의 details.code를 그대로 실어 보낸다. SSE 라우트는 전역 에러 핸들러를
        // 타지 않아(헤더가 이미 나갔다) 여기서 싣지 않으면 화면이 에러 종류를 구분할 수 없다.
        const details = error instanceof HttpError ? error.details : undefined;
        const code =
          details && typeof details === "object" && "code" in details
            ? (details as { code?: unknown }).code
            : undefined;
        sendEvent("error", { message, code, details });
      } finally {
        reply.raw.end();
      }
    }
  );

  app.get(
    "/api/chats/me/:id/messages",
    {
      schema: {
        tags: ["chat"],
        summary: "List chat messages",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            before_created_at: { type: "string", format: "date-time" },
            before_id: { type: "string", format: "uuid" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          allOf: [
            {
              if: { required: ["before_created_at"] },
              then: { required: ["before_id"] },
            },
            {
              if: { required: ["before_id"] },
              then: { required: ["before_created_at"] },
            },
          ],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: messageItemSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const query = listMessagesQuerySchema.parse(request.query);
      const userId = await getRequestUserId(request);
      const data = await service.listMessages({
        chatId: params.id,
        userId,
        beforeCreatedAt: query.before_created_at,
        beforeId: query.before_id,
        limit: query.limit,
      });
      return reply.send({ ok: true, data: data.map(mapMessage) });
    }
  );

  app.get(
    "/api/chats/me/:id/prompt-messages",
    {
      schema: {
        tags: ["chat"],
        summary: "List prompt messages for LLM",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: promptMessageItemSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = chatIdParamSchema.parse(request.params);
      const query = listPromptMessagesQuerySchema.parse(request.query);
      const userId = await getRequestUserId(request);
      const data = await service.listPromptMessages({
        chatId: params.id,
        userId,
        limit: query.limit,
      });
      return reply.send({ ok: true, data });
    }
  );
};
