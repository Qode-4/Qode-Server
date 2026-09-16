import { z } from "zod";
import type {
  PromptMessage,
  PythonSearchResult,
  RagResponse,
  RetrievedChunk,
  SearchResult,
  SourceInfo,
} from "./rag.types.js";

const pythonSearchResultSchema: z.ZodType<PythonSearchResult> = z.object({
  chunks: z.array(
    z.object({
      content: z.string(),
      metadata: z.object({
        source: z.string(),
        language: z.string(),
        extension: z.string().optional(),
        file_size: z.number().optional(),
        project_id: z.string(),
        chunk_index: z.number(),
        total_chunks: z.number(),
        start_line: z.number().optional(),
        end_line: z.number().optional(),
        score: z.number(),
      }),
    })
  ),
  search_meta: z.object({
    total_found: z.number(),
    after_filter: z.number().optional(),
    after_dedup: z.number().optional(),
    final: z.number().optional(),
    search_time_ms: z.number(),
    error: z.string().optional(),
  }),
});

// 열린 과제 13-19 — top_k 5 → 10. how 유형 질문은 정답 청크를 최대 8개까지 본다.
// 청크는 최대 1,000자라 10개면 1만 자 — 8,000자 예산이면 뒤쪽 2~3개가 조용히 잘린다.
// 두 값은 같이 움직여야 한다. Qode-python app/api/main.py 의 top_k 기본값과도 맞춘다.
export const RAG_TOP_K = 10;
export const RAG_CONTEXT_MAX_CHARS = 12_000;

export const normalizeSearchResult = (result: PythonSearchResult): SearchResult => ({
  search_meta: result.search_meta,
  chunks: result.chunks.map((chunk) => {
    const { score, ...metadata } = chunk.metadata;
    return {
      page_content: chunk.content,
      score,
      metadata,
    };
  }),
});

export class RagSearchClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      timeoutMs?: number;
    }
  ) {}

  async searchChunksRaw(
    query: string,
    projectId: string,
    topK = RAG_TOP_K
  ): Promise<PythonSearchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    const endpoint = new URL("/search", this.options.baseUrl);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          project_id: projectId,
          top_k: topK,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`RAG search failed: ${response.status} ${body.slice(0, 500)}`);
      }

      return pythonSearchResultSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("RAG search timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async searchChunks(query: string, projectId: string, topK = RAG_TOP_K): Promise<SearchResult> {
    const raw = await this.searchChunksRaw(query, projectId, topK);
    return normalizeSearchResult(raw);
  }
}

export const trimContext = (chunks: RetrievedChunk[], maxChars = RAG_CONTEXT_MAX_CHARS): RetrievedChunk[] => {
  const result: RetrievedChunk[] = [];
  let totalChars = 0;

  for (const chunk of chunks) {
    if (totalChars + chunk.page_content.length > maxChars) {
      break;
    }

    result.push(chunk);
    totalChars += chunk.page_content.length;
  }

  return result;
};

export const buildRagSystemPrompt = (searchResult: SearchResult): string => {
  const contextBlock = searchResult.chunks
    .map((chunk) => {
      const { source, start_line: startLine, end_line: endLine } = chunk.metadata;
      const lineInfo = startLine ? ` (L${startLine}-${endLine ?? startLine})` : "";
      return `--- ${source}${lineInfo} ---\n${chunk.page_content}`;
    })
    .join("\n\n");

  return [
    "너는 Qode의 코드 어시스턴트다.",
    "아래 참고 코드만 근거로 답변하고, 알 수 없는 내용은 추측하지 말고 모른다고 말한다.",
    "답변에는 관련 파일 경로와 라인 범위를 함께 포함한다.",
    "",
    "참고 코드:",
    contextBlock || "검색된 참고 코드가 없습니다.",
  ].join("\n");
};

export const buildRagMessages = (
  searchResult: SearchResult,
  userQuestion: string,
  chatHistory: PromptMessage[]
) => {
  const messages = [
    {
      role: "system" as const,
      content: buildRagSystemPrompt(searchResult),
    },
    ...chatHistory
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({
        role:
          message.role === "USER"
            ? ("user" as const)
            : message.role === "ASSISTANT"
              ? ("assistant" as const)
              : ("system" as const),
        content: message.content,
      })),
  ];

  if (!messages.some((item) => item.role === "user" && item.content === userQuestion)) {
    messages.push({
      role: "user" as const,
      content: userQuestion,
    });
  }

  return messages;
};

// 출처 미리보기 길이. 화면은 파일 경로와 줄 번호를 먼저 보여주고 본문은 보조 정보다.
const SNIPPET_MAX_LENGTH = 200;

export const deduplicateSources = (sources: SourceInfo[]): SourceInfo[] => {
  const byKey = new Map<string, SourceInfo>();

  for (const source of sources) {
    // 키에 줄 번호가 빠지면 같은 파일의 서로 다른 청크가 하나로 합쳐진다.
    const key = `${source.filePath}:${source.startLine ?? ""}`;
    const existing = byKey.get(key);

    if (!existing || source.relevanceScore > existing.relevanceScore) {
      byKey.set(key, source);
    }
  }

  return [...byKey.values()];
};

export const formatResponse = (llmAnswer: string, searchResult: SearchResult): RagResponse => {
  const sources = searchResult.chunks.map((chunk) => ({
    filePath: chunk.metadata.source,
    // splitter 가 청크 위치를 못 찾으면 start_line 이 없다(Qode-python fix/splitter-line-numbers).
    // undefined 가 아니라 명시적 null 로 보내 화면이 "값이 없다"를 구분하게 한다.
    startLine: chunk.metadata.start_line ?? null,
    endLine: chunk.metadata.end_line ?? chunk.metadata.start_line ?? null,
    snippet: chunk.page_content.slice(0, SNIPPET_MAX_LENGTH),
    relevanceScore: chunk.score,
  }));

  return {
    answer: llmAnswer,
    sources: deduplicateSources(sources),
  };
};
