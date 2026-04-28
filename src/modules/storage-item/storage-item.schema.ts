import { z } from "zod";

const titleSchema = z.string().trim().min(1).max(200);

const githubUrlRegex = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/;
const figmaDesignUrlRegex = /figma\.com\/design\//;
const figjamBoardUrlRegex = /figma\.com\/board\//;

const githubItemSchema = z.object({
  type: z.literal("github_repo"),
  title: titleSchema,
  url: z
    .string()
    .trim()
    .regex(githubUrlRegex, { message: "GitHub 레포 URL 형식이 아닙니다." }),
  metadata: z.object({
    owner: z.string().trim().min(1).max(100),
    repo: z.string().trim().min(1).max(100),
    defaultBranch: z.string().trim().min(1).max(100),
  }),
});

const figmaItemSchema = z.object({
  type: z.literal("figma"),
  title: titleSchema,
  url: z
    .string()
    .trim()
    .regex(figmaDesignUrlRegex, { message: "Figma design URL 형식이 아닙니다." }),
  metadata: z.object({
    fileKey: z.string().trim().min(1).max(100),
    nodeId: z.string().trim().min(1).max(50).optional(),
  }),
});

const figjamItemSchema = z.object({
  type: z.literal("figjam"),
  title: titleSchema,
  url: z
    .string()
    .trim()
    .regex(figjamBoardUrlRegex, { message: "FigJam URL 형식이 아닙니다." }),
  metadata: z.object({
    fileKey: z.string().trim().min(1).max(100),
  }),
});

export const createStorageItemBodySchema = z.discriminatedUnion("type", [
  githubItemSchema,
  figmaItemSchema,
  figjamItemSchema,
]);

export const updateStorageItemBodySchema = z.object({
  title: titleSchema,
});

export const storageItemProjectParamSchema = z.object({
  projectId: z.string().uuid(),
});

export const storageItemIdParamSchema = z.object({
  projectId: z.string().uuid(),
  id: z.string().uuid(),
});
