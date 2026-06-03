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

export type SourceInfo = {
  filePath: string;
  lineRange?: string;
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
