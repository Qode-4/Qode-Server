export type PythonRetrievedChunk = {
  content: string;
  metadata: {
    source: string;
    language: string;
    extension?: string;
    file_size?: number;
    project_id: string;
    chunk_index: number;
    total_chunks: number;
    start_line?: number;
    end_line?: number;
    score: number;
  };
};

export type PythonSearchResult = {
  chunks: PythonRetrievedChunk[];
  search_meta: {
    total_found: number;
    after_filter?: number;
    after_dedup?: number;
    final?: number;
    search_time_ms: number;
    error?: string;
  };
};

export type RetrievedChunk = {
  page_content: string;
  score: number;
  metadata: {
    source: string;
    language: string;
    chunk_index: number;
    start_line?: number;
    end_line?: number;
    project_id: string;
    extension?: string;
    file_size?: number;
    total_chunks?: number;
  };
};

export type SearchResult = {
  chunks: RetrievedChunk[];
  search_meta: PythonSearchResult["search_meta"];
};

// 화면(Qode-Fe api/contracts/chats.ts)이 기다리는 모양이다. 줄 번호는 문자열
// "L12-30" 이 아니라 숫자로 보낸다 — 화면이 startLine/endLine 을 직접 읽는다.
export type SourceInfo = {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  snippet: string;
  relevanceScore: number;
};

export type RagResponse = {
  answer: string;
  sources: SourceInfo[];
};

export type PromptMessage = {
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
};