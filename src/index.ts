import "./config/load-env.js";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { registerErrorHandler } from "./common/error-handler.js";
import { HttpError } from "./common/http-error.js";
import { env } from "./config/env.js";
import { AnalysisServerClient } from "./lib/analysis-server-client.js";
import { closeDbPool, getDbPool } from "./lib/db.js";
import { OpenAiClient } from "./lib/openai-client.js";
import { registerAuthRoutes } from "./modules/auth/auth.route.js";
import { PgAuthRepository } from "./modules/auth/auth.repository.js";
import { createChatRepository } from "./modules/chat/chat.repository.js";
import { registerChatRoutes } from "./modules/chat/chat.route.js";
import { initializeCoreSchema } from "./modules/core-schema/core-schema.repository.js";
import { PgFolderRepository } from "./modules/folder/folder.repository.js";
import { registerFolderRoutes } from "./modules/folder/folder.route.js";
import { registerGithubOauthRoutes } from "./modules/github-oauth/github-oauth.route.js";
import { PgGithubOauthRepository } from "./modules/github-oauth/github-oauth.repository.js";
import { GithubOauthService } from "./modules/github-oauth/github-oauth.service.js";
import { registerProjectAnalysisRoutes } from "./modules/project-analysis/project-analysis.route.js";
import { PgProjectAnalysisRepository } from "./modules/project-analysis/project-analysis.repository.js";
import { ProjectAnalysisService } from "./modules/project-analysis/project-analysis.service.js";
import { registerProjectRoutes } from "./modules/project/project.route.js";
import { PgProjectRepository } from "./modules/project/project.repository.js";
import { ProjectSyncCoordinator } from "./modules/project/project-sync.service.js";
import {
  buildRagMessages,
  formatResponse,
  RagSearchClient,
  trimContext,
} from "./modules/rag/rag.service.js";
import { registerSampleItemRoutes } from "./modules/sample-item/sample-item.route.js";
import { PgSampleItemRepository } from "./modules/sample-item/sample-item.repository.js";
import { registerStorageItemRoutes } from "./modules/storage-item/storage-item.route.js";
import { PgStorageItemRepository } from "./modules/storage-item/storage-item.repository.js";
import { PgSectionRepository } from "./modules/section/section.repository.js";
import { registerSectionRoutes } from "./modules/section/section.route.js";

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

// Swagger UI 문서를 노출합니다.
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
await initializeCoreSchema(dbPool);

const sampleItemRepository = new PgSampleItemRepository(dbPool);
const storageItemRepository = new PgStorageItemRepository(dbPool);
const projectRepository = new PgProjectRepository(dbPool);
const authRepository = new PgAuthRepository(dbPool);
const analysisServerClient =
  env.ANALYSIS_SERVER_URL && env.ANALYSIS_SERVER_INTERNAL_TOKEN
    ? new AnalysisServerClient({
        baseUrl: env.ANALYSIS_SERVER_URL,
        internalToken: env.ANALYSIS_SERVER_INTERNAL_TOKEN,
      })
    : null;
const openAiClient = env.OPENAI_API_KEY
  ? new OpenAiClient({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    })
  : null;
const projectAnalysisRepository = new PgProjectAnalysisRepository(dbPool);
const ragSearchClient = new RagSearchClient({
  baseUrl: env.RAG_SERVICE_URL,
});
const projectAnalysisService =
  openAiClient
    ? new ProjectAnalysisService(projectAnalysisRepository, projectRepository, openAiClient)
    : null;
const syncCoordinator = new ProjectSyncCoordinator(projectRepository, {
  onJobCompleted: analysisServerClient
    ? async ({ projectId, syncJobId }) => {
        await analysisServerClient.startIndexJob({ projectId, syncJobId });
      }
    : projectAnalysisService
      ? async ({ projectId, syncedCommit }) => {
          await projectAnalysisService.scheduleRebuild(projectId, syncedCommit);
        }
      : undefined,
});

app.get(
  "/health",
  {
    schema: {
      tags: ["system"],
      summary: "Health check",
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            service: { type: "string" },
            database: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                type: { type: "string", enum: ["postgres"] },
              },
              required: ["ok", "type"],
            },
            now: { type: "string", format: "date-time" },
          },
          required: ["ok", "service", "database", "now"],
        },
      },
    },
  },
  async () => {
    await dbPool.query("SELECT 1");
    return {
      ok: true,
      service: "qode-server",
      database: {
        ok: true,
        type: "postgres",
      },
      now: new Date().toISOString(),
    };
  }
);

app.get(
  "/internal/analysis-server/health",
  {
    schema: {
      tags: ["system"],
      summary: "Check analysis server health through Qode Server",
      headers: {
        type: "object",
        properties: {
          "x-qode-internal-token": { type: "string" },
        },
        required: ["x-qode-internal-token"],
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            service: { type: "string" },
            analysisServer: { type: "string" },
            now: { type: "string", format: "date-time" },
          },
          required: ["ok", "service", "analysisServer", "now"],
        },
      },
    },
  },
  async (request, reply) => {
    const internalToken = request.headers["x-qode-internal-token"];
    const actualToken = Array.isArray(internalToken) ? internalToken[0] : internalToken;
    if (
      !env.ANALYSIS_SERVER_INTERNAL_TOKEN ||
      !actualToken ||
      actualToken !== env.ANALYSIS_SERVER_INTERNAL_TOKEN
    ) {
      throw new HttpError(401, "Unauthorized internal request");
    }

    if (!analysisServerClient || !env.ANALYSIS_SERVER_URL) {
      throw new HttpError(503, "Analysis server is not configured");
    }

    try {
      await analysisServerClient.checkHealth();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis server health check failed";
      throw new HttpError(503, message);
    }

    return reply.send({
      ok: true,
      service: "qode-server",
      analysisServer: env.ANALYSIS_SERVER_URL,
      now: new Date().toISOString(),
    });
  }
);

await registerSampleItemRoutes(app, { repository: sampleItemRepository });
await registerAuthRoutes(app, { repository: authRepository });
const githubOauthRepository = new PgGithubOauthRepository(dbPool);
const githubOauthService = new GithubOauthService(githubOauthRepository);
const sectionRepository = new PgSectionRepository(dbPool);
const folderRepository = new PgFolderRepository(dbPool);
await registerGithubOauthRoutes(app, {
  repository: githubOauthRepository,
  authRepository,
});
await registerProjectRoutes(app, {
  repository: projectRepository,
  authRepository,
  githubOauthService,
  syncCoordinator,
  projectAnalysisService: projectAnalysisService ?? undefined,
});
await registerStorageItemRoutes(app, {
  repository: storageItemRepository,
  projectRepository,
  authRepository,
});
if (projectAnalysisService) {
  await registerProjectAnalysisRoutes(app, {
    analysisService: projectAnalysisService,
    authRepository,
  });
}
await registerSectionRoutes(app, {
  repository: sectionRepository,
  projectRepository,
  authRepository,
});
await registerFolderRoutes(app, {
  repository: folderRepository,
  sectionRepository,
  projectRepository,
  authRepository,
});

const chatRepository = createChatRepository(dbPool);
await registerChatRoutes(app, {
  repository: chatRepository,
  authRepository,
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

    const searchResult = await ragSearchClient.searchChunks(content, chat.project_id, 5);
    const trimmedSearchResult = {
      ...searchResult,
      chunks: trimContext(searchResult.chunks, 8_000),
    };
    const recentMessages = await chatRepository.listRecentForPrompt(chatId, 20);
    const openAiMessages = buildRagMessages(trimmedSearchResult, content, recentMessages);

    let fullContent = "";
    for await (const token of openAiClient.streamChat(openAiMessages)) {
      fullContent += token;
      yield token;
    }

    yield {
      type: "sources",
      sources: formatResponse(fullContent, searchResult).sources,
    };
  },
});

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
