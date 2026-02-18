import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { InMemoryAuthRepository, type AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import {
  createProjectBodySchema,
  projectIdParamSchema,
  updateProjectGitUrlBodySchema,
} from "./project.schema.js";
import {
  InMemoryProjectRepository,
  type ProjectRepository,
} from "./project.repository.js";
import { ProjectService } from "./project.service.js";

type RouteDeps = {
  repository?: ProjectRepository;
  authRepository?: AuthRepository;
};

export const registerProjectRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps = {}
) => {
  const repository = deps.repository ?? new InMemoryProjectRepository();
  const authRepository = deps.authRepository ?? new InMemoryAuthRepository();
  const authService = new AuthService(authRepository);
  const service = new ProjectService(repository);

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
    const data = await service.create(body, {
      id: me.id,
      name: me.name,
      avatarUrl: me.avatarUrl,
    });
    return reply.status(201).send({ ok: true, data });
  });

  app.patch("/api/projects/:id/git-url", async (request, reply) => {
    const params = projectIdParamSchema.parse(request.params);
    const body = updateProjectGitUrlBodySchema.parse(request.body);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const data = await service.updateGitUrl(params.id, me.id, body.gitUrl);
    return reply.send({ ok: true, data });
  });
};
