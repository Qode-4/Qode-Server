import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { env } from "../config/env.js";

let pool: Pool | null = null;

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const getDbPool = (): Pool => {
  // 프로세스 전역에서 싱글톤 풀을 지연 초기화해 재사용합니다.
  if (!pool) {
    const parsedUrl = new URL(env.DATABASE_URL);
    const isLocalDevelopmentDb =
      env.NODE_ENV === "development" && LOCAL_DB_HOSTS.has(parsedUrl.hostname);
    // 연결 문자열의 SSL 파라미터가 앱 레벨 SSL 정책을 덮어쓰지 않도록 제거합니다.
    parsedUrl.searchParams.delete("sslmode");
    parsedUrl.searchParams.delete("sslcert");
    parsedUrl.searchParams.delete("sslkey");
    parsedUrl.searchParams.delete("sslrootcert");

    const ca =
      env.DATABASE_SSL_CA_PATH !== undefined
        ? readFileSync(resolve(env.DATABASE_SSL_CA_PATH), "utf8")
        : undefined;

    const sslConfig =
      isLocalDevelopmentDb || env.DATABASE_SSL_MODE === "disable"
        ? false
        : {
            rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
            ca,
          };

    pool = new Pool({
      connectionString: parsedUrl.toString(),
      ssl: sslConfig,
    });
  }

  return pool;
};

export const closeDbPool = async (): Promise<void> => {
  if (!pool) {
    return;
  }

  // 테스트/재시작 시 깨끗하게 재초기화되도록 캐시된 풀 참조를 비웁니다.
  await pool.end();
  pool = null;
};
