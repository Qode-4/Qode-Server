import "dotenv/config";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { registerErrorHandler } from "./common/error-handler.js";
import { env } from "./config/env.js";
import { closeDbPool, getDbPool } from "./lib/db.js";
import { registerAuthRoutes } from "./modules/auth/auth.route.js";
import { InMemoryAuthRepository, PgAuthRepository } from "./modules/auth/auth.repository.js";
import { createChatRepository } from "./modules/chat/chat.repository.js";
import { registerChatRoutes } from "./modules/chat/chat.route.js";
import { initializeCoreSchema } from "./modules/core-schema/core-schema.repository.js";
import { registerProjectRoutes } from "./modules/project/project.route.js";
import { InMemoryProjectRepository, PgProjectRepository } from "./modules/project/project.repository.js";
import { registerSampleItemRoutes } from "./modules/sample-item/sample-item.route.js";
import { InMemorySampleItemRepository, PgSampleItemRepository } from "./modules/sample-item/sample-item.repository.js";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

// 엔트리포인트에서 Fastify 앱을 생성하고 모듈을 연결합니다.
const app = Fastify({
  logger: env.NODE_ENV !== "test",
});

registerErrorHandler(app);
await app.register(cookie);


// swagger-ui 
await app.register(swagger, {
  openapi: {
    info: {
      title: "Qode Server API",
      version: "0.1.0",
    },
    servers: [{ url: "/" }],
  },
});

await app.register(swaggerUi, {
  routePrefix: "/docs",
});

const dbPool = getDbPool();
if (dbPool) {
  // Postgres 사용 시 필요한 테이블이 존재하도록 보장합니다.
  await initializeCoreSchema(dbPool);
}

// 실행 환경에 따라 저장소 구현체를 전환합니다.
const sampleItemRepository = dbPool
  ? new PgSampleItemRepository(dbPool)
  : new InMemorySampleItemRepository();
const projectRepository = dbPool
  ? new PgProjectRepository(dbPool)
  : new InMemoryProjectRepository();
const authRepository = dbPool ? new PgAuthRepository(dbPool) : new InMemoryAuthRepository();

app.get("/health", async () => {
  return {
    ok: true,
    service: "qode-server",
    storage: dbPool ? "postgres" : "memory",
    now: new Date().toISOString(),
  };
});

await registerSampleItemRoutes(app, { repository: sampleItemRepository });
await registerProjectRoutes(app, { repository: projectRepository });
await registerAuthRoutes(app, { repository: authRepository });
if (dbPool) {
  await registerChatRoutes(app, {
    repository: createChatRepository(dbPool),
    // TODO: 실제 LLM 호출로 변경
    streamAssistant: async function* ({ content }) {
      const response = `Echo: ${content}`;
      const tokens = response.split(" ");
      for (const token of tokens) {
        yield `${token} `;
      }
    }
  })
}

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
