import { HttpError } from "../../common/http-error.js";
import type { createChatRepository } from "./chat.repository.js";

type ChatRepository = ReturnType<typeof createChatRepository>;

type SendUserMessageInput = {
  chatId: string;
  userId: string;
  content: string;
};

type StartAssistantMessageInput = {
  chatId: string;
  userId: string;
};

type FinalizeAssistantMessageInput = {
  messageId: string;
  content: string;
};

type FailAssistantMessageInput = {
  messageId: string;
  contentPartial?: string;
};

type ListMessagesInput = {
  chatId: string;
  userId: string;
  beforeCreatedAt?: string;
  beforeId?: string;
  limit?: number;
};

type ListPromptMessagesInput = {
  chatId: string;
  userId: string;
  limit?: number;
};

type ListMyChatsInput = {
  projectId: string;
  userId: string;
  limit?: number;
};

export class ChatService {
  constructor(private readonly repository: ChatRepository) {}

  private async getChatOrThrow(chatId: string) {
    const chat = await this.repository.getChatById(chatId);
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }
    return chat;
  }

  private async assertChatAccess(chatId: string, userId: string) {
    const chat = await this.getChatOrThrow(chatId);

    if (chat.chat_type === "PERSONAL") {
      if (chat.created_by !== userId) {
        throw new HttpError(403, "Forbidden");
      }
      return chat;
    }

    const isMember = await this.repository.isActiveMember(chatId, userId);
    if (!isMember) {
      throw new HttpError(403, "Forbidden");
    }

    return chat;
  }

  createPersonalChat(input: { projectId: string; userId: string; name: string }) {
    return this.repository.createChat({
      projectId: input.projectId,
      createdBy: input.userId,
      name: input.name,
      chatType: "PERSONAL",
    });
  }

  async listMyChats(input: ListMyChatsInput) {
    const chats = await this.repository.listChatsByProject({
      projectId: input.projectId,
      limit: input.limit,
    });
    return chats.filter((chat) => chat.created_by === input.userId && chat.chat_type === "PERSONAL");
  }

  async sendUserMessage(input: SendUserMessageInput) {
    await this.assertChatAccess(input.chatId, input.userId);
    return this.repository.insertMessage({
      chatId: input.chatId,
      userId: input.userId,
      role: "USER",
      content: input.content,
      status: "COMPLETE",
    });
  }

  async startAssistantMessage(input: StartAssistantMessageInput) {
    await this.assertChatAccess(input.chatId, input.userId);
    return this.repository.insertMessage({
      chatId: input.chatId,
      userId: null,
      role: "ASSISTANT",
      content: "",
      status: "STREAMING",
    });
  }

  finalizeAssistantMessage(input: FinalizeAssistantMessageInput) {
    return this.repository.finalizeMessage(input);
  }

  failAssistantMessage(input: FailAssistantMessageInput) {
    return this.repository.failMessage(input);
  }

  async listMessages(input: ListMessagesInput) {
    await this.assertChatAccess(input.chatId, input.userId);
    return this.repository.paginateMessages({
      chatId: input.chatId,
      beforeCreatedAt: input.beforeCreatedAt,
      beforeId: input.beforeId,
      limit: input.limit,
    });
  }

  async listPromptMessages(input: ListPromptMessagesInput) {
    await this.assertChatAccess(input.chatId, input.userId);
    return this.repository.listRecentForPrompt(input.chatId, input.limit);
  }
}
