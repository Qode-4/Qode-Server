import "dotenv/config";
import Fastify from "fastify";
import { registerErrorHandler } from "./common/error-handler.js";
import { env } from "./config/env.js";
import { closeDbPool, getDbPool } from "./lib/db.js";
import { registerSampleItemRoutes } from "./modules/sample-item/sample-item.route.js";
import {
  InMemorySampleItemRepository,
  PgSampleItemRepository,
  initializeSampleItemTable,
} from "./modules/sample-item/sample-item.repository.js";

// 엔트리포인트에서 Fastify 앱을 생성하고 모듈을 연결합니다.
const app = Fastify({
  logger: env.NODE_ENV !== "test",
});

registerErrorHandler(app);

const dbPool = getDbPool();
if (dbPool) {
  // Postgres 사용 시 필요한 테이블이 존재하도록 보장합니다.
  await initializeSampleItemTable(dbPool);
}

// 실행 환경에 따라 저장소 구현체를 전환합니다.
const sampleItemRepository = dbPool
  ? new PgSampleItemRepository(dbPool)
  : new InMemorySampleItemRepository();

app.get("/health", async () => {
  return {
    ok: true,
    service: "qode-server",
    storage: dbPool ? "postgres" : "memory",
    now: new Date().toISOString(),
  };
});

await registerSampleItemRoutes(app, { repository: sampleItemRepository });

// 정상 종료 시 DB 연결을 정리합니다.
app.addHook("onClose", async () => {
  await closeDbPool();
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
