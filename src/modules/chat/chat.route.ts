import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { createChatRepository } from "./chat.repository.js";
import {
  chatIdParamSchema,
  createChatBodySchema,
  listMyChatsQuerySchema,
  listMessagesQuerySchema,
  listPromptMessagesQuerySchema,
  sendUserMessageBodySchema,
} from "./chat.schema.js";
import { ChatService } from "./chat.service.js";

type ChatRepository = ReturnType<typeof createChatRepository>;

type StreamAssistantInput = {
  chatId: string;
  userId: string;
  content: string;
};

type RouteDeps = {
  repository: ChatRepository;
  streamAssistant?: (input: StreamAssistantInput) => AsyncIterable<string>;
};

export const registerChatRoutes = async (app: FastifyInstance, deps: RouteDeps) => {
  if (!deps.repository) {
    throw new HttpError(503, "Chat repository is unavailable");
  }

  const service = new ChatService(deps.repository);
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
      created_at: { type: "string", format: "date-time" },
    },
    required: ["id", "chat_id", "user_id", "role", "content", "status", "created_at"],
  } as const;

  const promptMessageItemSchema = {
    type: "object",
    properties: {
      role: { type: "string", enum: ["USER", "ASSISTANT", "SYSTEM"] },
      content: { type: "string" },
    },
    required: ["role", "content"],
  } as const;

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
            user_id: { type: "string", format: "uuid" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["project_id", "user_id"],
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
      const data = await service.listMyChats({
        projectId: query.project_id,
        userId: query.user_id,
        limit: query.limit,
      });
      return reply.send({ ok: true, data });
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
            created_by: { type: "string", format: "uuid" },
            chat_type: { type: "string", enum: ["PERSONAL"] },
            name: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["project_id", "created_by", "chat_type", "name"],
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
      if (body.chat_type !== "PERSONAL") {
        throw new HttpError(400, "Only PERSONAL chat is supported now");
      }

      const data = await service.createPersonalChat({
        projectId: body.project_id,
        userId: body.created_by,
        name: body.name,
      });
      return reply.status(201).send({ ok: true, data });
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
            user_id: { type: "string", format: "uuid" },
            content: { type: "string", minLength: 1, maxLength: 4000 },
          },
          required: ["user_id", "content"],
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
          userId: body.user_id,
          content: body.content,
        });

        const assistantMessage = await service.startAssistantMessage({
          chatId: params.id,
          userId: body.user_id,
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
        for await (const token of deps.streamAssistant({
          chatId: params.id,
          userId: body.user_id,
          content: body.content,
        })) {
          fullContent += token;
          sendEvent("token", { token });
        }

        if (!assistantMessageId) {
          throw new HttpError(500, "Assistant message id is missing");
        }

        await service.finalizeAssistantMessage({
          messageId: assistantMessageId,
          content: fullContent,
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
        sendEvent("error", { message });
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
            user_id: { type: "string", format: "uuid" },
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
          required: ["user_id"],
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
      const data = await service.listMessages({
        chatId: params.id,
        userId: query.user_id,
        beforeCreatedAt: query.before_created_at,
        beforeId: query.before_id,
        limit: query.limit,
      });
      return reply.send({ ok: true, data });
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
            user_id: { type: "string", format: "uuid" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["user_id"],
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
      const data = await service.listPromptMessages({
        chatId: params.id,
        userId: query.user_id,
        limit: query.limit,
      });
      return reply.send({ ok: true, data });
    }
  );
};
