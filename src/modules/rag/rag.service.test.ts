import { describe, expect, it } from "vitest";
import { buildRagSystemPrompt, formatResponse, trimContext } from "./rag.service.js";
import type { RetrievedChunk, SearchResult } from "./rag.types.js";

const chunk = (source: string, chars: number, score: number): RetrievedChunk => ({
  page_content: "x".repeat(chars),
  score,
  metadata: {
    source,
    language: "typescript",
    chunk_index: 0,
    start_line: 1,
    end_line: 10,
    project_id: "p1",
  },
});

const searchResult = (chunks: RetrievedChunk[]): SearchResult => ({
  chunks,
  search_meta: { total_found: chunks.length, search_time_ms: 1 },
});

describe("sources는 프롬프트에 실제로 들어간 청크만 가리킨다", () => {
  // 열린 과제 13-14 — trim 전 결과로 sources를 만들면
  // 프롬프트에 없던 청크가 답변 근거로 표시된다.
  it("trim으로 잘려나간 청크는 sources에 없다", () => {
    const kept = chunk("kept.ts", 100, 0.9);
    const dropped = chunk("dropped.ts", 100, 0.8);

    const trimmed = searchResult(trimContext([kept, dropped], 150));
    const { sources } = formatResponse("답변", trimmed);

    expect(trimmed.chunks).toHaveLength(1);
    expect(sources.map((s) => s.filePath)).toEqual(["kept.ts"]);
  });

  it("sources의 모든 파일은 프롬프트 본문에 등장한다", () => {
    const trimmed = searchResult(
      trimContext([chunk("a.ts", 100, 0.9), chunk("b.ts", 9_000, 0.8)], 8_000)
    );
    const prompt = buildRagSystemPrompt(trimmed);

    for (const source of formatResponse("답변", trimmed).sources) {
      expect(prompt).toContain(source.filePath);
    }
  });
});
