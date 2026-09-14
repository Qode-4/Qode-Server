import { describe, expect, it } from "vitest";
import { buildRagSystemPrompt, deduplicateSources, formatResponse, trimContext } from "./rag.service.js";
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

// 화면(Qode-Fe api/contracts/chats.ts)은 startLine/endLine 을 숫자로, snippet 을 문자열로
// 기다린다. 서버가 "L12-30" 문자열을 보내던 동안 화면의 줄 번호는 전부 '-' 로 나왔다.
describe("sources 계약 — 화면이 읽는 모양으로 내보낸다", () => {
  const lined = (source: string, start?: number, end?: number, score = 0.9): RetrievedChunk => ({
    page_content: "본문".repeat(200),
    score,
    metadata: { source, language: "typescript", chunk_index: 0, start_line: start, end_line: end, project_id: "p1" },
  });

  it("줄 번호를 숫자로 내보낸다", () => {
    const { sources } = formatResponse("답변", searchResult([lined("a.ts", 12, 30)]));

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ startLine: 12, endLine: 30 });
  });

  it("start_line 이 없으면 null 이다", () => {
    // Qode-python splitter 가 청크 위치를 못 찾은 경우. undefined 가 아니라 null 이어야
    // 화면의 `?? '-'` 분기가 "값 없음"으로 읽는다.
    const { sources } = formatResponse("답변", searchResult([lined("a.ts", undefined, undefined)]));

    expect(sources[0]).toMatchObject({ startLine: null, endLine: null });
  });

  it("end_line 이 없으면 start_line 으로 채운다", () => {
    const { sources } = formatResponse("답변", searchResult([lined("a.ts", 12, undefined)]));

    expect(sources[0]?.endLine).toBe(12);
  });

  it("snippet 을 200자로 자른다", () => {
    const { sources } = formatResponse("답변", searchResult([lined("a.ts", 1, 2)]));

    expect(sources[0]?.snippet).toHaveLength(200);
    expect(sources[0]?.snippet.startsWith("본문")).toBe(true);
  });

  it("같은 파일이라도 줄이 다르면 각각 남는다", () => {
    // 중복 제거 키에서 줄 번호가 빠지면 여기서 1개로 합쳐진다.
    const { sources } = formatResponse("답변", searchResult([lined("a.ts", 10, 20), lined("a.ts", 80, 90)]));

    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.startLine).sort((x, y) => Number(x) - Number(y))).toEqual([10, 80]);
  });

  it("같은 파일 같은 줄이면 점수 높은 쪽만 남는다", () => {
    const merged = deduplicateSources([
      { filePath: "a.ts", startLine: 10, endLine: 20, snippet: "낮음", relevanceScore: 0.1 },
      { filePath: "a.ts", startLine: 10, endLine: 20, snippet: "높음", relevanceScore: 0.9 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("높음");
  });
});

