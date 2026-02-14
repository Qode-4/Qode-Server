import { z } from "zod";

export const sampleItemIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createSampleItemBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000).optional(),
});

export const updateSampleItemBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: "At least one field is required",
  });
