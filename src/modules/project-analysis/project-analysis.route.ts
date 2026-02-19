import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { InMemoryAuthRepository, type AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { projectIdParamSchema } from "../project/project.schema.js";
import { ProjectAnalysisService } from "./project-analysis.service.js";

type RouteDeps = {
  analysisService: ProjectAnalysisService;
  authRepository?: AuthRepository;
};

export const registerProjectAnalysisRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps
) => {
  const authRepository = deps.authRepository ?? new InMemoryAuthRepository();
  const authService = new AuthService(authRepository);

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

  app.post("/api/projects/:id/analyze", async (request, reply) => {
    const params = projectIdParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);

    await deps.analysisService.requestRebuild(params.id, me.id);
    return reply.status(202).send({
      ok: true,
      data: {
        projectId: params.id,
        status: "building",
      },
    });
  });

  app.get("/api/projects/:id/analysis", async (request, reply) => {
    const params = projectIdParamSchema.parse(request.params);
    const token = getAccessToken(request.headers.authorization);
    const me = await authService.getMe(token);

    const analysis = await deps.analysisService.getOrThrow(params.id, me.id);
    return reply.send({
      ok: true,
      data: analysis,
    });
  });
};
