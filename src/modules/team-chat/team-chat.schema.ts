import z from "zod";

export const chatIdParamSchema = z.object({
    chatId: z.string().uuid()
});
export const projectIdParamSchema = z.object({
    projectId: z.string().uuid()
});
export const createRoomBodySchema = z.object({
    name: z.string().min(1).max(100)
});
export const getMessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().datetime().optional(),
});
// 명세 BR-D3-01. createRoomBodySchema 와 같은 한도다.
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