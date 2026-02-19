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
import { registerGithubOauthRoutes } from "./modules/github-oauth/github-oauth.route.js";
import { PgGithubOauthRepository } from "./modules/github-oauth/github-oauth.repository.js";
import { GithubOauthService } from "./modules/github-oauth/github-oauth.service.js";
import { registerProjectRoutes } from "./modules/project/project.route.js";
import { InMemoryProjectRepository, PgProjectRepository, type ProjectRepository } from "./modules/project/project.repository.js";
import { ProjectSyncCoordinator } from "./modules/project/project-sync.service.js";
import { registerSampleItemRoutes } from "./modules/sample-item/sample-item.route.js";
import { InMemorySampleItemRepository, PgSampleItemRepository } from "./modules/sample-item/sample-item.repository.js";

// 엔트리포인트에서 Fastify 앱을 생성하고 모듈을 연결합니다.
const app = Fastify({
  logger: env.NODE_ENV !== "test",
});

registerErrorHandler(app);
await app.register(cookie);

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
const syncCoordinator = new ProjectSyncCoordinator(projectRepository as ProjectRepository);

app.get("/health", async () => {
  return {
    ok: true,
    service: "qode-server",
    storage: dbPool ? "postgres" : "memory",
    now: new Date().toISOString(),
  };
});

await registerSampleItemRoutes(app, { repository: sampleItemRepository });
await registerAuthRoutes(app, { repository: authRepository });
if (dbPool) {
  const githubOauthRepository = new PgGithubOauthRepository(dbPool);
  const githubOauthService = new GithubOauthService(githubOauthRepository);
  await registerGithubOauthRoutes(app, {
    repository: githubOauthRepository,
    authRepository,
  });
  await registerProjectRoutes(app, {
    repository: projectRepository,
    authRepository,
    githubOauthService,
    syncCoordinator,
  });
} else {
  await registerProjectRoutes(app, { repository: projectRepository, authRepository, syncCoordinator });
}
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
