import { HttpError } from "../../common/http-error.js";
import type { SourceInfo } from "../rag/rag.types.js";
import type { DigestRepository } from "./digest.repository.js";
import {
  buildDigestPrompt,
  buildPartialSummaryPrompt,
  chunkToSourceInfo,
  needsMapReduce,
} from "./digest.prompt.js";
import type { DigestStreamOutput, QaSet } from "./digest.types.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type OpenAiClient = {
  streamChat: (messages: ChatMessage[], options?: { signal?: AbortSignal }) => AsyncIterable<string>;
};

export class DigestService {
  constructor(
    private readonly repository: DigestRepository,
    private readonly openAiClient: OpenAiClient | null
  ) {}

  /**
   * SSE 헤더가 나간 뒤에는 상태 코드를 바꿀 수 없다.
   * 권한/존재 검증은 전부 스트림을 열기 전에 끝낸다.
   */
  prepare = async (input: { chatId: string; userId: string; messageIds: string[] }) => {
    if (!this.openAiClient) {
      throw new HttpError(503, "OPENAI_API_KEY가 설정되지 않았습니다.");
    }

    const chat = await this.repository.getChatOwnership(input.chatId);
    if (!chat) throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
    if (chat.created_by !== input.userId) throw new HttpError(403, "Forbidden");

    const sets = await this.repository.findQaSets({
      chatId: input.chatId,
      userId: input.userId,
      messageIds: input.messageIds,
    });

    // 조용히 필터링하면 근거 일부가 빠진 문서가 생기고 사용자는 이유를 모른다.
    if (sets.length !== input.messageIds.length) {
      const found = new Set(sets.map((set) => set.answerMessageId));
      throw new HttpError(400, "일부 메시지를 사용할 수 없습니다.", {
        code: "DIGEST_MESSAGE_UNAVAILABLE",
        missing: input.messageIds.filter((id) => !found.has(id)),
      });
    }

    if (sets.every((set) => set.citedChunks.length === 0)) {
      throw new HttpError(422, "선택한 답변에 코드 근거가 없어 문서를 생성할 수 없습니다.", {
        code: "DIGEST_NO_EVIDENCE",
      });
    }

    return { chat, sets };
  };

  /** 에러는 yield 하지 않고 throw 한다. yield 하면 그 문자열이 본문에 섞인다. */
  async *stream(params: {
    sets: QaSet[];
    note?: string;
    signal: AbortSignal;
  }): AsyncGenerator<DigestStreamOutput, void, unknown> {
    const client = this.openAiClient;
    if (!client) throw new HttpError(503, "OPENAI_API_KEY가 설정되지 않았습니다.");

    let sets = params.sets;

    // 세트가 많으면 단일 호출로 컨텍스트가 터진다. 먼저 세트별로 압축한다.
    if (needsMapReduce(sets)) {
      const condensed: QaSet[] = [];
      for (const set of sets) {
        if (params.signal.aborted) return;
        let summary = "";
        for await (const token of client.streamChat(buildPartialSummaryPrompt(set), {
          signal: params.signal,
        })) {
          summary += token;
        }
        condensed.push({ ...set, answer: summary });
      }
      sets = condensed;
    }

    const { messages, usedChunks } = buildDigestPrompt(sets, { note: params.note });

    for await (const token of client.streamChat(messages, { signal: params.signal })) {
      if (params.signal.aborted) return;
      yield { type: "token", content: token };
    }

    // RetrievedChunk(nested snake_case) -> SourceInfo(flat camelCase) 변환.
    yield { type: "sources", sources: usedChunks.map(chunkToSourceInfo) };
  }

  /**
   * 미리보기 본문을 팀 채팅에 게시한다.
   *
   * 주의: 서버가 생성물을 저장하지 않으므로 content/sources 는 프론트가 되돌려준 값이고
   * 조작 가능하다. 게시자가 자기 이름으로 올리는 글이라는 전제를 받아들인 설계다.
   * 조작을 막아야 한다면 draft 를 서버에 저장하고 id 만 받는 방식으로 바꿔야 한다.
   */
  share = async (params: {
    sourceChatId: string;
    targetChatId: string;
    userId: string;
    content: string;
    sources: SourceInfo[];
  }) => {
    const sourceChat = await this.repository.getChatOwnership(params.sourceChatId);
    if (!sourceChat) throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
    if (sourceChat.created_by !== params.userId) throw new HttpError(403, "Forbidden");

    const allowed = await this.repository.canShareTo({
      targetChatId: params.targetChatId,
      userId: params.userId,
      projectId: sourceChat.project_id,
    });
    if (!allowed) {
      throw new HttpError(403, "해당 팀 채팅에 공유할 권한이 없습니다.", {
        code: "DIGEST_SHARE_FORBIDDEN",
      });
    }

    return this.repository.insertSharedMessage({
      targetChatId: params.targetChatId,
      userId: params.userId,
      content: params.content,
      sources: params.sources,
    });
  };
}

export const defaultTitle = (sets: QaSet[]) => {
  const first = sets[0]?.question?.trim() ?? "";
  if (!first) return "정리 문서";
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
};