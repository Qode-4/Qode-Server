import { z } from "zod";

export const createProjectBodySchema = z.object({
  // 명세 A-3. 화면(Qode-Fe 생성 모달)의 maxLength 와 같은 값이다.
  name: z.string().trim().min(2).max(50),
  description: z.string().trim().min(1).max(200).nullable().optional(),
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

// 초대 코드는 대문자 16진수 10자리로 발급되지만, legacy 폴백(8자리)도 받아야 하므로
// 길이를 좁히지 않고 형식만 제한합니다.
export const inviteCodeParamSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9]{4,16}$/),
});

export const projectMemberParamSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
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
