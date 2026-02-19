import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { InMemoryAuthRepository, type AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { flowIdParamSchema, listReposQuerySchema } from "./github-oauth.schema.js";
import { PgGithubOauthRepository } from "./github-oauth.repository.js";
import { GithubOauthService } from "./github-oauth.service.js";

type RouteDeps = {
  repository: PgGithubOauthRepository;
  authRepository?: AuthRepository;
};

export const registerGithubOauthRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps
) => {
  const authRepository = deps.authRepository ?? new InMemoryAuthRepository();
  const authService = new AuthService(authRepository);
  const service = new GithubOauthService(deps.repository);

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

  app.post("/api/github/oauth/device/start", async (request, reply) => {
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const flow = await service.startDeviceFlow(me.id);

    return reply.send({
      ok: true,
      data: {
        flowId: flow.flowId,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        verificationUriComplete: flow.verificationUriComplete,
        expiresAt: flow.expiresAt,
        interval: flow.intervalSec,
      },
    });
  });

  app.get("/api/github/oauth/device/flows/:flowId", async (request, reply) => {
    const params = flowIdParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const flow = await service.getFlowOrThrow(params.flowId, me.id);
    return reply.send({ ok: true, data: flow });
  });

  app.get("/api/github/oauth/repos", async (request, reply) => {
    const query = listReposQuerySchema.parse(request.query);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);
    const repos = await service.listRepos(query.flowId, me.id);
    return reply.send({ ok: true, data: repos });
  });
};
