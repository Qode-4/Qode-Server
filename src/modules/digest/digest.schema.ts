import { z } from "zod";

export const MAX_MESSAGES_PER_DIGEST = 20;
/** 중복 안내 조회의 시간 창. 이보다 오래된 공유는 새 공유로 취급한다. */
export const RECENT_SHARE_WINDOW_DAYS = 30;

export const chatIdParamSchema = z.object({ id: z.string().uuid() });
export const digestMessageIdParamSchema = z.object({ digestMessageId: z.string().uuid() });

/** 쿼리스트링은 문자열로 오므로 CSV 로 받아 UUID 배열로 파싱한다. */
export const recentShareQuerySchema = z.object({
  message_ids: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(
      z
        .array(z.string().uuid())
        .min(1)
        .max(MAX_MESSAGES_PER_DIGEST)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "message_ids must not contain duplicates",
        })
    ),
});

export const previewDigestBodySchema = z.object({
  /** ASSISTANT 메시지 id. 질문은 서버가 messages.question_message_id 로 역추적한다. */
  message_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_MESSAGES_PER_DIGEST)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "message_ids must not contain duplicates",
    }),
    /** 질문자가 공유하며 덧붙이는 한 줄 메모. 프롬프트에 맥락으로 들어간다. */
    note: z.string().max(500).optional(),
});

const sourceInfoSchema = z.object({
  filePath: z.string().max(1000),
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  snippet: z.string().max(5000),
  relevanceScore: z.number(),
});

/**
 * 프론트가 미리보기에서 받은 본문을 그대로 돌려보낸다.
 * 서버가 원본을 들고 있지 않으므로 여기 오는 값은 조작 가능하다는 점을 전제로 한다.
 * 그래서 크기 상한만 엄격히 건다.
 */
export const shareDigestBodySchema = z.object({
  target_chat_id: z.string().uuid(),
  /** preview 시 넘긴 것과 같은 message_id 배열. 원문 스냅샷을 서버가 재조회할 때 쓴다. */
  message_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_MESSAGES_PER_DIGEST)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "message_ids must not contain duplicates",
    }),
  /** 질문자가 preview 때 붙인 메모. snapshot 에 그대로 보관해 원문과 함께 되돌려준다. */
  note: z.string().max(500).optional(),
  title: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(50_000),
  sources: z.array(sourceInfoSchema).max(100).default([]),
});

export const messageItemJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    chat_id: { type: "string", format: "uuid" },
    user_id: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    role: { type: "string", enum: ["USER", "ASSISTANT", "SYSTEM"] },
    content: { type: "string" },
    status: { type: "string", enum: ["COMPLETE", "STREAMING", "FAILED"] },
    sources: { type: "array" },
    created_at: { type: "string", format: "date-time" },
    deleted_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
  required: ["id", "chat_id", "user_id", "role", "content", "status", "sources", "created_at"],
} as const;

export const recentShareItemJsonSchema = {
  type: "object",
  properties: {
    digestMessageId: { type: "string", format: "uuid" },
    targetChatId: { type: "string", format: "uuid" },
    sharedAt: { type: "string", format: "date-time" },
  },
  required: ["digestMessageId", "targetChatId", "sharedAt"],
} as const;

export const digestSourcePairJsonSchema = {
  type: "object",
  properties: {
    questionMessageId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    question: { type: "string" },
    answerMessageId: { type: "string", format: "uuid" },
    answer: { type: "string" },
    sources: { type: "array" },
  },
  required: ["questionMessageId", "question", "answerMessageId", "answer", "sources"],
} as const;

export const digestSourceJsonSchema = {
  type: "object",
  properties: {
    note: { anyOf: [{ type: "string" }, { type: "null" }] },
    pairs: { type: "array", items: digestSourcePairJsonSchema },
    sharedAt: { type: "string", format: "date-time" },
  },
  required: ["note", "pairs", "sharedAt"],
} as const;