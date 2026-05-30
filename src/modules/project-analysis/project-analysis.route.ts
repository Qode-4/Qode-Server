import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { projectIdParamSchema } from "../project/project.schema.js";
import { ProjectAnalysisService } from "./project-analysis.service.js";

type RouteDeps = {
  analysisService: ProjectAnalysisService;
  authRepository: AuthRepository;
};

export const registerProjectAnalysisRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps
) => {
  const authService = new AuthService(deps.authRepository);
  const authHeaderSchema = {
    type: "object",
    properties: {
      authorization: { type: "string" },
    },
    required: ["authorization"],
  } as const;
  const analyzeStatusSchema = {
    type: "object",
    properties: {
      projectId: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["building", "ready", "failed"] },
    },
    required: ["projectId", "status"],
  } as const;
  const analysisSummarySchema = {
    type: "object",
    properties: {
      project_overview: { type: "string" },
      architecture: { type: "array", items: { type: "string" } },
      core_modules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            purpose: { type: "string" },
          },
          required: ["path", "purpose"],
        },
      },
      key_flows: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      recommended_next_steps: { type: "array", items: { type: "string" } },
    },
    required: [
      "project_overview",
      "architecture",
      "core_modules",
      "key_flows",
      "risks",
      "recommended_next_steps",
    ],
  } as const;
  const projectAnalysisSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      version: { type: "integer" },
      status: { type: "string", enum: ["building", "ready", "failed"] },
      summary: { anyOf: [analysisSummarySchema, { type: "null" }] },
      sourceCommit: { anyOf: [{ type: "string" }, { type: "null" }] },
      errorMessage: { anyOf: [{ type: "string" }, { type: "null" }] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "projectId",
      "version",
      "status",
      "summary",
      "sourceCommit",
      "errorMessage",
      "createdAt",
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

  app.post(
    "/api/projects/:id/analyze",
    {
      schema: {
        tags: ["project-analysis"],
        summary: "Request project analysis rebuild",
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
              data: analyzeStatusSchema,
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

      await deps.analysisService.requestRebuild(params.id, me.id);
      return reply.status(202).send({
        ok: true,
        data: {
          projectId: params.id,
          status: "building",
        },
      });
    }
  );

  app.get(
    "/api/projects/:id/analysis",
    {
      schema: {
        tags: ["project-analysis"],
        summary: "Get project analysis",
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
              data: projectAnalysisSchema,
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

      const analysis = await deps.analysisService.getOrThrow(params.id, me.id);
      return reply.send({
        ok: true,
        data: analysis,
      });
    }
  );
};
