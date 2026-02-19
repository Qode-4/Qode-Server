import { z } from "zod";

export const flowIdParamSchema = z.object({
  flowId: z.string().uuid(),
});

export const listReposQuerySchema = z.object({
  flowId: z.string().uuid(),
});
