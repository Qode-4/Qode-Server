import { HttpError } from "../../common/http-error.js";
import { resolveUniqueChatName } from "./unique-name.js";
import type { ProjectRepository } from "../project/project.repository.js";
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
  questionMessageId: string;
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

// 명세 BR-D2-03. 한 사용자가 한 프로젝트에서 가질 수 있는 개인 채팅 수다.
export const MAX_PERSONAL_CHATS = 100;

export class ChatService {
  constructor(
    private readonly repository: ChatRepository,
    private readonly projectRepository: ProjectRepository
  ) {}

  // 인덱싱이 끝나기 전에는 검색할 코드가 없어 LLM이 근거 없이 답한다.
  // 질문이 저장되기 전에 끊어야 답 없는 유령 메시지가 남지 않는다 → ADR-005
  private async assertProjectReady(projectId: string) {
    const job = await this.projectRepository.findRunningSyncJobByProject(projectId);
    if (!job) {
      return;
    }
    // job 자체의 존재로 판단한다. progress는 0일 수 있어 참/거짓으로 쓰면 막 시작한 동기화를 놓친다.
    throw new HttpError(409, "코드를 동기화하는 중입니다. 잠시 후 다시 시도해주세요.", {
      code: "SYNC_IN_PROGRESS",
      progress: job.progress,
    });
  }

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

  // 명세 BR-D2-03. 문구는 "이전 채팅을 삭제해주세요"여야 한다 —
  // 개인 채팅은 질문을 던지면 자동으로도 만들어지므로(BR-D2-06), 한도에 닿으면
  // 질문 자체가 막힌다. 사용자가 스스로 풀 방법을 알려주지 않으면 막다른 길이 된다.
  //
  // ponytail: 세는 것과 넣는 것 사이에 틈이 있어 동시 생성 시 한도를 한둘 넘을 수 있다.
  // 20명 상한·프로젝트 이름 중복과 같은 성격이고 베타 규모에서 수용한다.
  private async assertRoomForPersonalChats(projectId: string, userId: string) {
    const current = await this.repository.countPersonalChats({ projectId, userId });
    if (current >= MAX_PERSONAL_CHATS) {
      throw new HttpError(409, "채팅방 최대 개수에 도달했습니다. 이전 채팅을 삭제해주세요.");
    }
  }

  async createPersonalChat(input: { projectId: string; userId: string; name: string }) {
    await this.assertRoomForPersonalChats(input.projectId, input.userId);
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

    // BR-D3-04. 같은 범위에 같은 이름이 있으면 "(N)" 을 붙이고 최종 이름을 돌려준다.
    const taken = await this.repository.listPersonalChatNames({
      projectId: chat.project_id,
      userId: input.userId,
      excludeChatId: input.chatId,
    });
    const finalName = resolveUniqueChatName(input.name, taken);

    const updated = await this.repository.updateChatName(input.chatId, finalName);
    if (!updated) {
      throw new HttpError(404, "Chat not found");
    }
    return updated;
  }

  async sendUserMessage(input: SendUserMessageInput) {
    const chat = await this.assertChatAccess(input.chatId, input.userId);
    await this.assertProjectReady(chat.project_id);
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
      questionMessageId: input.questionMessageId,
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
