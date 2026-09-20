import type { Pool } from "pg";
import type { RetrievedChunk, SourceInfo } from "../rag/rag.types.js";
import type { QaSet } from "./digest.types.js";

type QaJoinRow = {
  answer_message_id: string;
  answer: string;
  question_message_id: string | null;
  question: string | null;
  cited_chunks: RetrievedChunk[] | null;
};

export type SharedMessageRow = {
  id: string;
  chat_id: string;
  user_id: string | null;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  status: "COMPLETE" | "STREAMING" | "FAILED";
  sources: SourceInfo[];
  created_at: string;
};

export const createDigestRepository = (db: Pool) => ({
  /**
   * 소유권까지 한 쿼리에서 검증한다.
   * message id 배열을 받는 API 는 IDOR 의 전형이므로 chat_id + created_by 조건을 빼면 안 된다.
   * 반환 row 수가 messageIds.length 와 다르면 호출 측에서 거절할 것.
   */
  findQaSets: async (params: {
    chatId: string;
    userId: string;
    messageIds: string[];
  }): Promise<QaSet[]> => {
    const { rows } = await db.query<QaJoinRow>(
      `
      SELECT
        a.id            AS answer_message_id,
        a.content       AS answer,
        q.id            AS question_message_id,
        q.content       AS question,
      COALESCE(
          NULLIF(cs.cited_chunks, '[]'::jsonb),
          cs.all_chunks,
          '[]'::jsonb
        ) AS cited_chunks
      FROM messages a
      JOIN chats c
        ON c.id = a.chat_id
      LEFT JOIN message_context_snapshots cs
        ON cs.message_id = a.id
      LEFT JOIN messages q
        ON q.id = a.question_message_id
      WHERE a.id = ANY($1::uuid[])
        AND a.chat_id = $2
        AND c.created_by = $3
        AND a.role = 'ASSISTANT'
        AND a.status = 'COMPLETE'
      `,
      [params.messageIds, params.chatId, params.userId]
    );

    // 프론트가 보낸 순서를 보존한다. SQL 반환 순서는 신뢰하지 않는다.
    const byId = new Map(rows.map((row) => [row.answer_message_id, row]));
    return params.messageIds
      .map((id) => byId.get(id))
      .filter((row): row is QaJoinRow => Boolean(row))
      .map((row) => ({
        answerMessageId: row.answer_message_id,
        answer: row.answer,
        questionMessageId: row.question_message_id,
        question: row.question ?? "",
        citedChunks: row.cited_chunks ?? [],
      }));
  },

  getChatOwnership: async (chatId: string) => {
    const { rows } = await db.query<{ id: string; project_id: string; created_by: string }>(
      `SELECT id, project_id, created_by FROM chats WHERE id = $1`,
      [chatId]
    );
    return rows[0] ?? null;
  },

  /**
   * 공유 대상 팀 채팅 검증. 여기가 유일한 보안 경계다.
   * - TEAM 채팅인가
   * - 원본 개인 채팅과 같은 프로젝트인가 (프로젝트 간 유출 차단)
   * - 요청자가 아직 나가지 않은 참여자인가
   */
  canShareTo: async (params: {
    targetChatId: string;
    userId: string;
    projectId: string;
  }): Promise<boolean> => {
    const { rowCount } = await db.query(
      `
      SELECT 1
      FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE c.id = $1
        AND c.chat_type = 'TEAM'
        AND c.project_id = $3
        AND cp.user_id = $2
        AND cp.left_at IS NULL
      LIMIT 1
      `,
      [params.targetChatId, params.userId, params.projectId]
    );
    return (rowCount ?? 0) > 0;
  },

  /** 팀 채팅에 한 건 게시. messages.id 에 DEFAULT 가 없으므로 직접 생성한다. */
  insertSharedMessage: async (params: {
    targetChatId: string;
    userId: string;
    content: string;
    sources: SourceInfo[];
  }): Promise<SharedMessageRow> => {
        const { rows } = await db.query<SharedMessageRow>(
      `
      INSERT INTO messages (id, chat_id, user_id, role, content, status, sources)
      VALUES (gen_random_uuid(), $1, $2, 'ASSISTANT', $3, 'COMPLETE', $4::jsonb)
      RETURNING id, chat_id, user_id, role, content, status, sources, created_at
      `,
    [params.targetChatId, params.userId, params.content, JSON.stringify(params.sources)]
    );

    // noUncheckedIndexedAccess 때문에 rows[0] 은 undefined 가능이다.
    // 단언(!)으로 넘기면 INSERT 실패 시 undefined 가 서비스까지 흘러가 엉뚱한 곳에서 터진다.
    const inserted = rows[0];
    if (!inserted) throw new Error("Failed to insert shared digest message");
    return inserted;
  },
});

export type DigestRepository = ReturnType<typeof createDigestRepository>;