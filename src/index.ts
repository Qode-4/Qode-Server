import "dotenv/config";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { registerErrorHandler } from "./common/error-handler.js";
import { env } from "./config/env.js";
import { closeDbPool, getDbPool } from "./lib/db.js";
import { OpenAiClient } from "./lib/openai-client.js";
import { registerAuthRoutes } from "./modules/auth/auth.route.js";
import { InMemoryAuthRepository, PgAuthRepository } from "./modules/auth/auth.repository.js";
import { createChatRepository } from "./modules/chat/chat.repository.js";
import { registerChatRoutes } from "./modules/chat/chat.route.js";
import { initializeCoreSchema } from "./modules/core-schema/core-schema.repository.js";
import { registerGithubOauthRoutes } from "./modules/github-oauth/github-oauth.route.js";
import { PgGithubOauthRepository } from "./modules/github-oauth/github-oauth.repository.js";
import { GithubOauthService } from "./modules/github-oauth/github-oauth.service.js";
import { registerProjectAnalysisRoutes } from "./modules/project-analysis/project-analysis.route.js";
import { PgProjectAnalysisRepository } from "./modules/project-analysis/project-analysis.repository.js";
import { ProjectAnalysisService } from "./modules/project-analysis/project-analysis.service.js";
import { registerProjectRoutes } from "./modules/project/project.route.js";
import { InMemoryProjectRepository, PgProjectRepository, type ProjectRepository } from "./modules/project/project.repository.js";
import { ProjectSyncCoordinator } from "./modules/project/project-sync.service.js";
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

const CORS_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const CORS_DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization";

app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }
  if (!env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    return;
  }

  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Credentials", "true");

  if (request.method !== "OPTIONS") {
    return;
  }

  const requestedHeaders = request.headers["access-control-request-headers"];
  const allowedHeaders = Array.isArray(requestedHeaders)
    ? requestedHeaders.join(", ")
    : requestedHeaders ?? CORS_DEFAULT_ALLOWED_HEADERS;
  reply.header("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
  reply.header("Access-Control-Allow-Headers", allowedHeaders);
  reply.header("Access-Control-Max-Age", "86400");
  reply.code(204).send();
});


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
const openAiClient = env.OPENAI_API_KEY
  ? new OpenAiClient({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    })
  : null;
const projectAnalysisRepository = dbPool ? new PgProjectAnalysisRepository(dbPool) : null;
const projectAnalysisService =
  projectAnalysisRepository && openAiClient
    ? new ProjectAnalysisService(projectAnalysisRepository, projectRepository as ProjectRepository, openAiClient)
    : null;
const syncCoordinator = new ProjectSyncCoordinator(projectRepository as ProjectRepository, {
  onJobCompleted: projectAnalysisService
    ? async ({ projectId, syncedCommit }) => {
        await projectAnalysisService.scheduleRebuild(projectId, syncedCommit);
      }
    : undefined,
});

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
  if (projectAnalysisService) {
    await registerProjectAnalysisRoutes(app, {
      analysisService: projectAnalysisService,
      authRepository,
    });
  }
} else {
  await registerProjectRoutes(app, { repository: projectRepository, authRepository, syncCoordinator });
}
if (dbPool) {
  const chatRepository = createChatRepository(dbPool);
  await registerChatRoutes(app, {
    repository: chatRepository,
    streamAssistant: async function* ({ chatId, content }) {
      if (!openAiClient) {
        yield "OPENAI_API_KEY가 설정되지 않아 AI 응답을 생성할 수 없습니다.";
        return;
      }

      const chat = await chatRepository.getChatById(chatId);
      if (!chat) {
        yield "채팅방을 찾을 수 없습니다.";
        return;
      }

      const analysis = projectAnalysisRepository
        ? await projectAnalysisRepository.findByProjectId(chat.project_id)
        : null;
      const recentMessages = await chatRepository.listRecentForPrompt(chatId, 20);
      const openAiMessages = [
        {
          role: "system" as const,
          content: [
            "You are Qode coding assistant.",
            "Use only the provided project analysis cache as ground truth.",
            "If information is not in cache, say it is not present in analysis cache.",
            "",
            "Project analysis cache:",
            analysis?.status === "ready" && analysis.summary
              ? JSON.stringify(analysis.summary)
              : "analysis cache is unavailable.",
          ].join("\n"),
        },
        ...recentMessages
          .filter((message) => message.content.trim().length > 0)
          .map((message) => ({
            role:
              message.role === "USER"
                ? ("user" as const)
                : message.role === "ASSISTANT"
                  ? ("assistant" as const)
                  : ("system" as const),
            content: message.content,
          })),
      ];

      if (!openAiMessages.some((item) => item.role === "user" && item.content === content)) {
        openAiMessages.push({
          role: "user",
          content,
        });
      }

      for await (const token of openAiClient.streamChat(openAiMessages)) {
        yield token;
      }
    },
  });
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
