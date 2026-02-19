import { z } from "zod";

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000).nullable().optional(),
  git: z
    .object({
      provider: z.literal("github_oauth"),
      flowId: z.string().uuid(),
      owner: z.string().trim().min(1).max(100),
      repo: z.string().trim().min(1).max(100),
      defaultBranch: z.string().trim().min(1).max(100),
    })
    .optional(),
});

export const projectIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const projectSyncJobParamSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
});

export const projectSyncStatusParamSchema = z.object({
  projectId: z.string().uuid(),
});

export const inviteProjectMembersBodySchema = z.object({
  emails: z.array(z.string().trim().email().max(100)).min(1).max(50),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, rawEmail] of value.emails.entries()) {
    const normalized = rawEmail.trim().toLowerCase();
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "중복된 이메일은 허용되지 않습니다.",
        path: ["emails", index],
      });
      continue;
    }
    seen.add(normalized);
  }
});
