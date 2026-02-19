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

  app.get("/api/projects", async (request, reply) => {
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await service.list(me.id);
    return reply.send({ ok: true, data });
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const params = projectIdParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await service.getByIdOrThrow(params.id, me.id);
    return reply.send({ ok: true, data });
  });

  app.get("/api/projects/:id/members", async (request, reply) => {
    const params = projectIdParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await service.listMembersOrThrow(params.id, me.id);
    return reply.send({ ok: true, data });
  });
   
  app.post("/api/projects", async (request, reply) => {
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
  });

  app.post("/api/projects/:id/sync", async (request, reply) => {
    const params = projectIdParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await syncService.requestSync(params.id, me.id);
    return reply.status(202).send({ ok: true, data });
  });

  app.get("/api/projects/:projectId/sync/status", async (request, reply) => {
    const params = projectSyncStatusParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await syncService.getLatestSyncStatusOrThrow(params.projectId, me.id);
    return reply.send({ ok: true, data });
  });

  app.get("/api/projects/:id/sync-jobs/:jobId", async (request, reply) => {
    const params = projectSyncJobParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await syncService.getSyncJobOrThrow(params.id, params.jobId, me.id);
    return reply.send({ ok: true, data });
  });
};
