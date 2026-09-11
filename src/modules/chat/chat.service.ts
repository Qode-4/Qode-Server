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

type DeleteMyChatInput = {
  chatId: string;
  userId: string;
};

type RenameMyChatInput = {
  chatId: string;
  userId: string;
  name: string;
};

type GenerateTitleFn = (input: {
  userContent: string;
  assistantContent: string;
}) => Promise<string>;

export class ChatService {
  constructor(
    private readonly repository: ChatRepository,
    private readonly generateTitle?: GenerateTitleFn
  ) {}

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

  async deleteMyChat(input: DeleteMyChatInput) {
    const chat = await this.getChatOrThrow(input.chatId);
    if (chat.chat_type !== "PERSONAL") {
      throw new HttpError(400, "Only PERSONAL chat can be deleted now");
    }
    if (chat.created_by !== input.userId) {
      throw new HttpError(403, "Forbidden");
    }

    const deleted = await this.repository.deleteChatById(input.chatId);
    if (!deleted) {
      throw new HttpError(404, "Chat not found");
    }
  }

  async renameMyChat(input: RenameMyChatInput) {
    const chat = await this.getChatOrThrow(input.chatId);
    if (chat.chat_type !== "PERSONAL") {
      throw new HttpError(400, "Only PERSONAL chat can be renamed now");
    }
    if (chat.created_by !== input.userId) {
      throw new HttpError(403, "Forbidden");
    }

    const updated = await this.repository.updateChatName(input.chatId, input.name);
    if (!updated) {
      throw new HttpError(404, "Chat not found");
    }
    return updated;
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

  async maybeGenerateTitleForFirstTurn(input: {
    chatId: string;
    userContent: string;
    assistantContent: string;
  }): Promise<{ name: string } | null> {
    if (!this.generateTitle) return null;
    try {
      const count = await this.repository.countMessages(input.chatId);
      if (count !== 2) return null;

      const raw = await this.generateTitle({
        userContent: input.userContent,
        assistantContent: input.assistantContent,
      });
      const name = raw.trim().slice(0, 20);
      if (!name) return null;

      const updated = await this.repository.updateChatName(input.chatId, name);
      if (!updated) return null;
      return { name };
    } catch {
      return null;
    }
  }
}
