import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { createChatRepository } from "./chat.repository.js";
import {
  chatIdParamSchema,
  createChatBodySchema,
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

  app.post("/api/chats/me", async (request, reply) => {
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
  });

  // AI streaming message endpoint
  app.post("/api/chats/me/:id/messages", async (request, reply) => {
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
  });

  // Full message list for UI/debug
  app.get("/api/chats/me/:id/messages", async (request, reply) => {
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
  });

  // Prompt messages for LLM input
  app.get("/api/chats/me/:id/prompt-messages", async (request, reply) => {
    const params = chatIdParamSchema.parse(request.params);
    const query = listPromptMessagesQuerySchema.parse(request.query);
    const data = await service.listPromptMessages({
      chatId: params.id,
      userId: query.user_id,
      limit: query.limit,
    });
    return reply.send({ ok: true, data });
  });
};
