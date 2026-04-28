import { z } from "zod";

const sectionNameSchema = z.string().trim().min(1).max(120);

export const projectSectionParamSchema = z.object({
  projectId: z.string().uuid(),
});

export const sectionIdParamSchema = z.object({
  sectionId: z.string().uuid(),
});

export const createSectionBodySchema = z.object({
  name: sectionNameSchema,
});

export const updateSectionBodySchema = z.object({
  name: sectionNameSchema,
});
