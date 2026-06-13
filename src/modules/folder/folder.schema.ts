import { z } from "zod";

const folderNameSchema = z.string().trim().min(1).max(120);

export const sectionIdParamSchema = z.object({
  sectionId: z.string().uuid(),
});

export const folderIdParamSchema = z.object({
  folderId: z.string().uuid(),
});

export const createFolderBodySchema = z.object({
  name: folderNameSchema,
});

export const updateFolderBodySchema = z.object({
  name: folderNameSchema,
});
