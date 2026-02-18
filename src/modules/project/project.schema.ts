import { z } from "zod";

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000).nullable().optional(),
  gitUrl: z.string().trim().url().nullable().optional(),
});

export const projectIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const updateProjectGitUrlBodySchema = z.object({
  gitUrl: z.string().trim().min(1).max(2048),
});
