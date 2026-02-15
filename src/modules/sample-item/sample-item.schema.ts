import { z } from "zod";

// 상세/수정/삭제 엔드포인트에서 사용하는 UUID 경로 파라미터 스키마입니다.
export const sampleItemIdParamSchema = z.object({
  id: z.string().uuid(),
});

// 생성 엔드포인트 요청 본문 검증 스키마입니다.
export const createSampleItemBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000).optional(),
});

// PATCH 요청에는 수정 가능한 필드가 최소 1개 이상 포함되어야 합니다.
export const updateSampleItemBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: "At least one field is required",
  });
