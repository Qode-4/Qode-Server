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
export const addParticipantBodySchema = z.object({
    userId: z.string().uuid()
});