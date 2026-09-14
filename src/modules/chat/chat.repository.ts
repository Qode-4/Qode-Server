import type { Pool } from "pg";
import { randomUUID } from "crypto";

export type ChatType = "PERSONAL" | "TEAM";
export type MemberRole = "OWNER" | "ADMIN" | "MEMBER";

export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type MessageStatus = "COMPLETE" | "STREAMING" | "FAILED";

export function createChatRepository(pool: Pool) {
  // =========================
  // Chat
  // =========================
  async function getChatById(chatId: string): Promise<{
    id: string;
    project_id: string;
    created_by: string;
    name: string;
    chat_type: ChatType;
    created_at: string;
  } | null> {
    const q = `
      SELECT id, project_id, created_by, name, chat_type, created_at
      FROM chats
      WHERE id = $1
      LIMIT 1
    `;
    const r = await pool.query(q, [chatId]);
    return r.rows[0] ?? null;
  }

  async function createChat(params: {
    projectId: string;
    createdBy: string;
    name: string;
    chatType?: ChatType;
  }) {
    const id = randomUUID();
    const chatType: ChatType = params.chatType ?? "PERSONAL";

    const q = `
      INSERT INTO chats (id, project_id, created_by, name, chat_type)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, project_id, created_by, name, chat_type, created_at
    `;
    const r = await pool.query(q, [id, params.projectId, params.createdBy, params.name, chatType]);
    return r.rows[0];
  }

  // 개인 채팅은 created_by 로 걸러 각자 자기 것만 본다(listMyChats).
  // 그래서 한도도 사용자별로 센다 — 프로젝트 전체로 세면 남이 만든, 보이지도 않는
  // 채팅 때문에 막히고 사용자는 원인을 알 수 없다.
  async function countPersonalChats(params: { projectId: string; userId: string }) {
    const r = await pool.query<{ count: string }>(
      `
      SELECT count(*) AS count
      FROM chats
      WHERE project_id = $1 AND created_by = $2 AND chat_type = 'PERSONAL'
      `,
      [params.projectId, params.userId]
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  async function listChatsByProject(params: { projectId: string; limit?: number }) {
    const limit = params.limit ?? 50;
    const q = `
      SELECT id, project_id, created_by, name, chat_type, created_at
      FROM chats
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const r = await pool.query(q, [params.projectId, limit]);
    return r.rows;
  }

  async function deleteChatById(chatId: string) {
    const q = `
      DELETE FROM chats
      WHERE id = $1
    `;
    const r = await pool.query(q, [chatId]);
    return (r.rowCount ?? 0) > 0;
  }

  async function updateChatName(chatId: string, name: string) {
    const q = `
      UPDATE chats
      SET name = $2
      WHERE id = $1
      RETURNING id, project_id, created_by, name, chat_type, created_at
    `;
    const r = await pool.query(q, [chatId, name]);
    return r.rows[0] ?? null;
  }

  // =========================
  // Participants (TEAM 권한 체크용)
  // =========================
  async function isActiveMember(chatId: string, userId: string): Promise<boolean> {
    const q = `
      SELECT 1
      FROM chat_participants
      WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL
      LIMIT 1
    `;
    const r = await pool.query(q, [chatId, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async function addParticipant(params: {
    chatId: string;
    userId: string;
    role?: MemberRole;
  }) {
    const role: MemberRole = params.role ?? "MEMBER";
    const q = `
      INSERT INTO chat_participants (chat_id, user_id, member_role)
      VALUES ($1, $2, $3)
      ON CONFLICT (chat_id, user_id) DO UPDATE
      SET member_role = EXCLUDED.member_role,
          left_at = NULL
      RETURNING chat_id, user_id, member_role, created_at, left_at
    `;
    const r = await pool.query(q, [params.chatId, params.userId, role]);
    return r.rows[0];
  }

  async function markLeft(params: { chatId: string; userId: string }) {
    const q = `
      UPDATE chat_participants
      SET left_at = NOW()
      WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL
    `;
    await pool.query(q, [params.chatId, params.userId]);
  }

  // =========================
  // Messages (스트리밍 핵심)
  // =========================
  async function insertMessage(params: {
    chatId: string;
    userId?: string | null;
    role: MessageRole;
    content?: string;
    status?: MessageStatus;
    id?: string;
  }) {
    const id = params.id ?? randomUUID();
    const content = params.content ?? "";
    const status: MessageStatus =
      params.status ?? (params.role === "ASSISTANT" ? "STREAMING" : "COMPLETE");
    const userId = params.userId ?? null;

    const q = `
      INSERT INTO messages (id, chat_id, user_id, role, content, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, chat_id, user_id, role, content, status, created_at
    `;
    const r = await pool.query(q, [id, params.chatId, userId, params.role, content, status]);
    return r.rows[0];
  }

  async function listRecentForPrompt(chatId: string, limit = 20): Promise<Array<{ role: MessageRole; content: string }>> {
    const q = `
      SELECT role, content
      FROM messages
      WHERE chat_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const r = await pool.query(q, [chatId, limit]);
    return r.rows.reverse();
  }

  async function finalizeMessage(params: { messageId: string; content: string }) {
    const q = `
      UPDATE messages
      SET content = $2, status = 'COMPLETE'
      WHERE id = $1
      RETURNING id
    `;
    const r = await pool.query(q, [params.messageId, params.content]);
    if ((r.rowCount ?? 0) === 0) {
      throw new Error("Message not found");
    }
  }

  async function failMessage(params: { messageId: string; contentPartial?: string }) {
    const q = `
      UPDATE messages
      SET content = COALESCE($2, content), status = 'FAILED'
      WHERE id = $1
      RETURNING id
    `;
    const r = await pool.query(q, [params.messageId, params.contentPartial ?? null]);
    if ((r.rowCount ?? 0) === 0) {
      throw new Error("Message not found");
    }
  }

  /**
   * 과거 메시지 페이징(무한스크롤)
   * before: created_at + id 복합 커서
   */
  async function paginateMessages(params: {
    chatId: string;
    beforeCreatedAt?: string;
    beforeId?: string;
    limit?: number;
  }) {
    const limit = params.limit ?? 30;
    const hasCursor = Boolean(params.beforeCreatedAt && params.beforeId);

    const q = hasCursor
      ? `
        SELECT id, chat_id, user_id, role, content, status, created_at
        FROM messages
        WHERE chat_id = $1
          AND (
            created_at < $2
            OR (created_at = $2 AND id < $3)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `
      : `
        SELECT id, chat_id, user_id, role, content, status, created_at
        FROM messages
        WHERE chat_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `;

    const args = hasCursor
      ? [params.chatId, params.beforeCreatedAt, params.beforeId, limit]
      : [params.chatId, limit];
    const r = await pool.query(q, args);
    // Keep DESC query for stable cursor pagination, but return ASC for UI rendering order.
    return r.rows.reverse();
  }

  return {
    // Chat
    getChatById,
    createChat,
    countPersonalChats,
    listChatsByProject,
    deleteChatById,
    updateChatName,

    // Participants
    isActiveMember,
    addParticipant,
    markLeft,

    // Messages
    insertMessage,
    listRecentForPrompt,
    finalizeMessage,
    failMessage,
    paginateMessages,
  };
}
