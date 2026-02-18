import { z } from "zod";

export const messageStatusSchema = z.enum(["COMPLETE", "STREAMING", "FAILED"]);   // 메시지 상태 검증
export const chatTypeSchema = z.enum(["PERSONAL", "TEAM"]); // 채팅 타입 검증
export const chatMemberRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);   // 참여자 권한 검증 (default: MEMEBER)

// ID가 UUID인지 검증
export const chatIdParamSchema = z.object({
  id: z.string().uuid(),
});

// URL 파라미터 ID가 UUID인지 검증
export const messageIdParamSchema = z.object({
  id: z.string().uuid(),
});

// chat_id와 user_id 모두 UUID인지 검증
export const chatParticipantParamSchema = z.object({
  chat_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

// 채팅방 생성 요청 body 검증
// TODO: 채팅 이름 최대 길이 논의
export const createChatBodySchema = z.object({
  project_id: z.string().uuid(),
  created_by: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  chat_type: chatTypeSchema,
});

// 채팅방 수정 요청 body 검증
export const updateChatBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    chat_type: chatTypeSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.chat_type !== undefined, {
    message: "At least one field is required",
  });

// 메시지 생성 요청 body 검증
export const createMessageBodySchema = z.object({
  chat_id: z.string().uuid(),
  user_id: z.string().uuid().nullable().optional(), // AI인 경우
  content: z.string().trim().min(1).max(4000),
  status: messageStatusSchema.optional().default("COMPLETE"),
});

// 메시지 수정 요청 body 검증
// TODO(chat): 채팅 수정 기능 정책 미논의. 팀 논의 후 결정
export const updateMessageBodySchema = z
  .object({
    content: z.string().trim().min(1).max(4000).optional(),
    status: messageStatusSchema.optional(),
  })
  .refine((value) => value.content !== undefined || value.status !== undefined, {
    message: "At least one field is required",
  });

export const sendUserMessageBodySchema = z.object({
  user_id: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
});

export const listMessagesQuerySchema = z
  .object({
    user_id: z.string().uuid(),
    before_created_at: z.string().datetime().optional(),
    before_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine(
    (value) =>
      (value.before_created_at === undefined && value.before_id === undefined) ||
      (value.before_created_at !== undefined && value.before_id !== undefined),
    {
      message: "before_created_at and before_id must be provided together",
      path: ["before_id"],
    }
  );

export const listPromptMessagesQuerySchema = z.object({
  user_id: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const finalizeMessageBodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export const failMessageBodySchema = z.object({
  content_partial: z.string().trim().min(1).max(4000).optional(),
});

// 참여자 추가 요청 body 검증
// TODO(chat): 참여자 추가 기능 정책 미논의. 팀 논의 후 결정
export const createChatParticipantBodySchema = z.object({
  chat_id: z.string().uuid(),
  user_id: z.string().uuid(),
  member_role: chatMemberRoleSchema.optional().default("MEMBER"),
});

// 참여자 정보 수정 요청 body 검증
export const updateChatParticipantBodySchema = z
  .object({
    member_role: chatMemberRoleSchema.optional(),
    left_at: z.string().datetime().nullable().optional(),
  })
  .refine((value) => value.member_role !== undefined || value.left_at !== undefined, {
    message: "At least one field is required",
  });
