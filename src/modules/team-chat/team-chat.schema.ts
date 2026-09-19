import z from "zod";

// 활성 참여자 기준(chat_participants.left_at IS NULL). 방장 1명 포함.
export const TEAM_CHAT_MIN_PARTICIPANTS = 2;
export const TEAM_CHAT_MAX_PARTICIPANTS = 20;

export const chatIdParamSchema = z.object({
    chatId: z.string().uuid()
});
export const projectIdParamSchema = z.object({
    projectId: z.string().uuid()
});
// 생성자 자신은 서버가 자동으로 방장으로 넣으므로 memberIds 는 최대 (MAX - 1) 명이다.
export const createRoomBodySchema = z.object({
    name: z.string().trim().min(1).max(100),
    memberIds: z.array(z.string().uuid()).min(1).max(TEAM_CHAT_MAX_PARTICIPANTS - 1),
});
export const getMessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().datetime().optional(),
});
// 명세 BR-D3-01.
export const renameRoomBodySchema = z.object({
    name: z.string().trim().min(1).max(100)
});
export const projectChatParamSchema = z.object({
    projectId: z.string().uuid(),
    chatId: z.string().uuid()
});
export const addParticipantBodySchema = z.object({
    userId: z.string().uuid()
});
export const chatUserParamSchema = z.object({
    chatId: z.string().uuid(),
    userId: z.string().uuid(),
});
export const transferOwnershipBodySchema = z.object({
    newOwnerId: z.string().uuid(),
});
