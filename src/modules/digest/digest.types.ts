import type { RetrievedChunk, SourceInfo } from "../rag/rag.types.js";

/**
 * 질의-답변 한 세트.
 * 프론트는 message id 만 보내고 본문은 서버가 messages 에서 읽는다.
 * (본문을 프론트가 보내면 근거 스냅샷과 짝이 어긋날 수 있다.)
 */
export type QaSet = {
  questionMessageId: string | null;
  question: string;
  answerMessageId: string;
  answer: string;
  /** 실제 인용된 청크만. all_chunks 는 쓰지 않는다. */
  citedChunks: RetrievedChunk[];
};

/** 스트림 출력은 전부 discriminated union. 생 string 을 섞지 않는다. */
export type DigestStreamOutput =
  | { type: "token"; content: string }
  | { type: "sources"; sources: SourceInfo[] };

/** share 시점에 서버가 채운다. 원본 개인채팅이 나중에 삭제/수정돼도 B2 조회는 이 스냅샷으로 답한다. */
export type DigestSnapshotPair = {
  questionMessageId: string | null;
  question: string;
  answerMessageId: string;
  answer: string;
  sources: SourceInfo[];
};

export type DigestSnapshot = {
  note: string | null;
  pairs: DigestSnapshotPair[];
};

export type RecentShareItem = {
  digestMessageId: string;
  targetChatId: string;
  sharedAt: string;
};