import type { Pool } from "pg";
import type { RetrievedChunk, SourceInfo } from "../rag/rag.types.js";
import type {
  DigestSnapshot,
  DigestSourceResponse,
  QaSet,
  RecentShareItem,
} from "./digest.types.js";

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
  deleted_at: string | null;
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

  /**
   * 팀 채팅 카드 게시 + 공유 이력(스냅샷) 저장을 한 트랜잭션으로 묶는다.
   * 카드만 올라가고 이력이 없으면 원문 조회/재공유 판정에 쓰이는 스냅샷이 깨진다.
   */
  insertSharedMessageWithSnapshot: async (params: {
    sourceChatId: string;
    targetChatId: string;
    userId: string;
    content: string;
    sources: SourceInfo[];
    sourceMessageIds: string[];
    snapshot: DigestSnapshot;
  }): Promise<SharedMessageRow> => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const { rows: msgRows } = await client.query<SharedMessageRow>(
        `
        INSERT INTO messages (id, chat_id, user_id, role, content, status, sources)
        VALUES (gen_random_uuid(), $1, $2, 'ASSISTANT', $3, 'COMPLETE', $4::jsonb)
        RETURNING id, chat_id, user_id, role, content, status, sources, created_at, deleted_at
        `,
        [params.targetChatId, params.userId, params.content, JSON.stringify(params.sources)]
      );
      const inserted = msgRows[0];
      if (!inserted) throw new Error("Failed to insert shared digest message");

      await client.query(
        `
        INSERT INTO digest_shares
          (id, source_chat_id, target_chat_id, digest_message_id, shared_by,
           source_message_ids, snapshot)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid[], $6::jsonb)
        `,
        [
          params.sourceChatId,
          params.targetChatId,
          inserted.id,
          params.userId,
          params.sourceMessageIds,
          JSON.stringify(params.snapshot),
        ]
      );

      await client.query("COMMIT");
      return inserted;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * 완전 일치(source_message_ids 배열 동등) + 최근 N일 이력 조회.
   * PG 의 = 로 uuid[] 정확 비교. 순서가 달라도 같은 조합을 매칭하려면 정렬본을 저장해야 하는데,
   * 프론트 UX 상 preview 화면에서 선택 순서를 유지하므로 배열 순서까지 같은 것만 "중복" 으로 본다.
   * 이미 회수(soft delete) 된 카드는 안내 대상에서 뺀다.
   */
  findRecentSharesByExactMessageIds: async (params: {
    sourceChatId: string;
    userId: string;
    messageIds: string[];
    windowDays: number;
  }): Promise<RecentShareItem[]> => {
    const { rows } = await db.query<{
      digest_message_id: string;
      target_chat_id: string;
      created_at: string;
    }>(
      `
      SELECT s.digest_message_id, s.target_chat_id, s.created_at
      FROM digest_shares s
      JOIN messages m ON m.id = s.digest_message_id
      WHERE s.source_chat_id = $1
        AND s.shared_by = $2
        AND s.source_message_ids = $3::uuid[]
        AND s.created_at > NOW() - ($4::int || ' days')::interval
        AND m.deleted_at IS NULL
      ORDER BY s.created_at DESC
      `,
      [params.sourceChatId, params.userId, params.messageIds, params.windowDays]
    );
    return rows.map((row) => ({
      digestMessageId: row.digest_message_id,
      targetChatId: row.target_chat_id,
      sharedAt: row.created_at,
    }));
  },

  /**
   * 팀채팅 카드에서 "원본 대화 열기"용. 요청자가 대상 팀채팅의 활성 참여자여야만 반환한다.
   * 스냅샷을 쓰므로 원본 개인채팅이 지워져도 답이 유지된다.
   */
  getShareByDigestMessageIdIfMember: async (params: {
    digestMessageId: string;
    userId: string;
  }): Promise<DigestSourceResponse | null> => {
    const { rows } = await db.query<{ snapshot: DigestSnapshot; created_at: string }>(
      `
      SELECT s.snapshot, s.created_at
      FROM digest_shares s
      JOIN chat_participants cp
        ON cp.chat_id = s.target_chat_id
       AND cp.user_id = $2
       AND cp.left_at IS NULL
      WHERE s.digest_message_id = $1
      LIMIT 1
      `,
      [params.digestMessageId, params.userId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      note: row.snapshot.note ?? null,
      pairs: row.snapshot.pairs ?? [],
      sharedAt: row.created_at,
    };
  },

  /**
   * 팀채팅 메시지 컨텍스트 — 삭제 권한 판정용.
   * 한 번의 조회로 소유자·digest 카드 여부·방장 여부·이미 삭제됐는지를 뽑는다.
   */
  getTeamMessageForDelete: async (params: {
    chatId: string;
    messageId: string;
    userId: string;
  }): Promise<{
    userId: string | null;
    isDigest: boolean;
    sharedBy: string | null;
    isChatOwner: boolean;
    alreadyDeleted: boolean;
  } | null> => {
    const { rows } = await db.query<{
      user_id: string | null;
      deleted_at: string | null;
      share_by: string | null;
      role: string;
      is_chat_owner: boolean;
    }>(
      `
      SELECT
        m.user_id,
        m.deleted_at,
        m.role,
        s.shared_by AS share_by,
        EXISTS (
          SELECT 1 FROM chat_participants cp
          WHERE cp.chat_id = $1
            AND cp.user_id = $3
            AND cp.left_at IS NULL
            AND cp.member_role = 'OWNER'
        ) AS is_chat_owner
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      LEFT JOIN digest_shares s ON s.digest_message_id = m.id
      WHERE m.id = $2 AND m.chat_id = $1 AND c.chat_type = 'TEAM'
      `,
      [params.chatId, params.messageId, params.userId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      isDigest: row.share_by !== null,
      sharedBy: row.share_by,
      isChatOwner: row.is_chat_owner,
      alreadyDeleted: row.deleted_at !== null,
    };
  },

  softDeleteTeamMessage: async (messageId: string): Promise<boolean> => {
    const { rowCount } = await db.query(
      `UPDATE messages SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [messageId]
    );
    return (rowCount ?? 0) > 0;
  },
});

export type DigestRepository = ReturnType<typeof createDigestRepository>;