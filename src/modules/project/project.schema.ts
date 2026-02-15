import { z } from "zod";

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000).nullable().optional(),
  gitUrl: z.string().trim().url().nullable().optional(),
  createdBy: z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    avatarUrl: z.string().trim().url().nullable().optional(),
  }),
});
