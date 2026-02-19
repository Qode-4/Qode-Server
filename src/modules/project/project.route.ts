import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { InMemoryAuthRepository, type AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import {
  createProjectBodySchema,
  projectIdParamSchema,
  projectSyncJobParamSchema,
  projectSyncStatusParamSchema,
} from "./project.schema.js";
import {
  InMemoryProjectRepository,
  type ProjectRepository,
} from "./project.repository.js";
import type { GithubOauthService } from "../github-oauth/github-oauth.service.js";
import { ProjectSyncCoordinator, ProjectSyncService } from "./project-sync.service.js";
import { ProjectService } from "./project.service.js";

type RouteDeps = {
  repository?: ProjectRepository;
  authRepository?: AuthRepository;
  syncCoordinator?: ProjectSyncCoordinator;
  githubOauthService?: GithubOauthService;
};

export const registerProjectRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps = {}
) => {
  const repository = deps.repository ?? new InMemoryProjectRepository();
  const authRepository = deps.authRepository ?? new InMemoryAuthRepository();
  const authService = new AuthService(authRepository);
  const service = new ProjectService(repository);
  const syncCoordinator = deps.syncCoordinator ?? new ProjectSyncCoordinator(repository);
  const syncService = new ProjectSyncService(repository, syncCoordinator);
  const authHeaderSchema = {
    type: "object",
    properties: {
      authorization: { type: "string" },
    },
    required: ["authorization"],
  } as const;

  const projectSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      description: { anyOf: [{ type: "string" }, { type: "null" }] },
      gitUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
      inviteCode: { type: "string" },
      lastSyncedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      questionCount: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      createdBy: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          avatarUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["id", "name", "avatarUrl"],
      },
      role: { type: "string", enum: ["OWNER", "MEMBER"] },
    },
    required: [
      "id",
      "name",
      "description",
      "gitUrl",
      "inviteCode",
      "lastSyncedAt",
      "questionCount",
      "createdAt",
      "createdBy",
      "role",
    ],
  } as const;

  const projectMemberSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      avatarUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
      role: { type: "string", enum: ["OWNER", "MEMBER"] },
      joinedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    },
    required: ["id", "name", "avatarUrl", "role", "joinedAt"],
  } as const;

  const syncJobSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      requestedBy: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["queued", "syncing", "done", "failed"] },
      progress: { type: "integer", minimum: 0, maximum: 100 },
      errorCode: {
        anyOf: [
          {
            type: "string",
            enum: [
              "PROJECT_SYNC_PROJECT_NOT_FOUND",
              "PROJECT_SYNC_FORBIDDEN",
              "PROJECT_SYNC_ALREADY_RUNNING",
              "PROJECT_SYNC_REPO_NOT_CONFIGURED",
              "PROJECT_SYNC_JOB_NOT_FOUND",
              "PROJECT_SYNC_OAUTH_REAUTH_REQUIRED",
              "PROJECT_SYNC_REPO_ACCESS_DENIED_OR_NOT_FOUND",
              "PROJECT_SYNC_NETWORK_ERROR",
              "PROJECT_SYNC_TIMEOUT",
              "PROJECT_SYNC_STORAGE_ERROR",
              "PROJECT_SYNC_UNKNOWN_ERROR",
            ],
          },
          { type: "null" },
        ],
      },
      errorMessage: { anyOf: [{ type: "string" }, { type: "null" }] },
      syncedCommit: { anyOf: [{ type: "string" }, { type: "null" }] },
      createdAt: { type: "string", format: "date-time" },
      startedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      finishedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "projectId",
      "requestedBy",
      "status",
      "progress",
      "errorCode",
      "errorMessage",
      "syncedCommit",
      "createdAt",
      "startedAt",
      "finishedAt",
      "updatedAt",
    ],
  } as const;

  const getAccessToken = (authorization?: string): string => {
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    return token;
  };

  app.get(
    "/api/projects",
    {
      schema: {
        tags: ["project"],
        summary: "List projects for current user",
        headers: authHeaderSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: projectSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.list(me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.get(
    "/api/projects/:id",
    {
      schema: {
        tags: ["project"],
        summary: "Get project by id",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: projectSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.getByIdOrThrow(params.id, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.get(
    "/api/projects/:id/members",
    {
      schema: {
        tags: ["project"],
        summary: "List project members",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: projectMemberSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.listMembersOrThrow(params.id, me.id);
      return reply.send({ ok: true, data });
    }
  );
   
  app.post(
    "/api/projects",
    {
      schema: {
        tags: ["project"],
        summary: "Create project",
        headers: authHeaderSchema,
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            description: { anyOf: [{ type: "string", minLength: 1, maxLength: 1000 }, { type: "null" }] },
            git: {
              type: "object",
              properties: {
                provider: { type: "string", enum: ["github_oauth"] },
                flowId: { type: "string", format: "uuid" },
                owner: { type: "string", minLength: 1, maxLength: 100 },
                repo: { type: "string", minLength: 1, maxLength: 100 },
                defaultBranch: { type: "string", minLength: 1, maxLength: 100 },
              },
              required: ["provider", "flowId", "owner", "repo", "defaultBranch"],
            },
          },
          required: ["name"],
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  description: { anyOf: [{ type: "string" }, { type: "null" }] },
                  gitUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
                  inviteCode: { type: "string" },
                  lastSyncedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
                  questionCount: { type: "integer" },
                  createdAt: { type: "string", format: "date-time" },
                  createdBy: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      name: { type: "string" },
                      avatarUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
                    },
                    required: ["id", "name", "avatarUrl"],
                  },
                  role: { type: "string", enum: ["OWNER", "MEMBER"] },
                  syncJob: { anyOf: [syncJobSchema, { type: "null" }] },
                },
                required: [
                  "id",
                  "name",
                  "description",
                  "gitUrl",
                  "inviteCode",
                  "lastSyncedAt",
                  "questionCount",
                  "createdAt",
                  "createdBy",
                  "role",
                  "syncJob",
                ],
              },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const body = createProjectBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const project = await service.create(
        { name: body.name, description: body.description ?? null, gitUrl: null },
        {
          id: me.id,
          name: me.name,
          avatarUrl: me.avatarUrl,
        }
      );

      let syncJob = null;
      if (body.git) {
        const githubOauthService = deps.githubOauthService;
        if (!githubOauthService) {
          throw new HttpError(503, "GitHub OAuth 기능을 사용할 수 없습니다.");
        }

        const tokenRefId = await githubOauthService.getAuthorizedTokenRefIdOrThrow(
          body.git.flowId,
          me.id
        );
        const repoMeta = await githubOauthService.verifyRepoAccess({
          tokenRefId,
          owner: body.git.owner,
          repo: body.git.repo,
        });

        // TODO(정책보류): 프로젝트 OWNER 변경/탈퇴 시 token_ref_id 승계/재매핑 정책 미정.
        await repository.createGitConnection({
          projectId: project.id,
          provider: "github_oauth",
          owner: body.git.owner,
          repo: body.git.repo,
          defaultBranch: body.git.defaultBranch || repoMeta.defaultBranch,
          gitUrl: repoMeta.gitUrl,
          tokenRefId,
          connectedBy: me.id,
        });

        syncJob = await repository.createSyncJob({
          projectId: project.id,
          requestedBy: me.id,
        });
        syncCoordinator.enqueue(syncJob);
      }

      const data = {
        ...project,
        syncJob,
      };
      return reply.status(201).send({ ok: true, data });
    }
  );

  app.post(
    "/api/projects/:id/sync",
    {
      schema: {
        tags: ["project"],
        summary: "Request project sync",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        response: {
          202: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: syncJobSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await syncService.requestSync(params.id, me.id);
      return reply.status(202).send({ ok: true, data });
    }
  );

  app.get(
    "/api/projects/:projectId/sync/status",
    {
      schema: {
        tags: ["project"],
        summary: "Get latest project sync status",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
          },
          required: ["projectId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["idle", "queued", "syncing", "done", "failed"] },
                  latestJob: { anyOf: [syncJobSchema, { type: "null" }] },
                },
                required: ["status", "latestJob"],
              },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectSyncStatusParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await syncService.getLatestSyncStatusOrThrow(params.projectId, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.get(
    "/api/projects/:id/sync-jobs/:jobId",
    {
      schema: {
        tags: ["project"],
        summary: "Get project sync job detail",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            jobId: { type: "string", format: "uuid" },
          },
          required: ["id", "jobId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: syncJobSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectSyncJobParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await syncService.getSyncJobOrThrow(params.id, params.jobId, me.id);
      return reply.send({ ok: true, data });
    }
  );
};
