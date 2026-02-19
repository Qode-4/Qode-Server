import { z } from "zod";

// 자주 쓰는 boolean 형태의 환경변수 문자열을 파싱합니다(true/1/yes/on, false/0/no/off).
const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

// 애플리케이션 시작 시 엄격히 검증하기 위한 환경변수 스키마입니다.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("require"),
  DATABASE_SSL_REJECT_UNAUTHORIZED: booleanFromEnv.default(false),
  DATABASE_SSL_CA_PATH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
  GITHUB_OAUTH_SCOPES: z.string().min(1).default("repo read:user"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SYNC_REPO_BASE_DIR: z.string().min(1).default("./.data/repos"),
  SYNC_WORKER_ENABLED: booleanFromEnv.default(true),
  SYNC_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
});

export const env = envSchema.parse(process.env);

// 운영 환경에서 외부 DB 설정 누락으로 잘못 기동되는 것을 방지합니다.
if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set in production");
}
