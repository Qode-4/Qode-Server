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
  const authHeaderSchema = {
    type: "object",
    properties: {
      authorization: { type: "string" },
    },
    required: ["authorization"],
  } as const;

  const flowSchema = {
    type: "object",
    properties: {
      flowId: { type: "string", format: "uuid" },
      requestedBy: { type: "string", format: "uuid" },
      deviceCode: { type: "string" },
      userCode: { type: "string" },
      verificationUri: { type: "string" },
      verificationUriComplete: { anyOf: [{ type: "string" }, { type: "null" }] },
      expiresAt: { type: "string", format: "date-time" },
      intervalSec: { type: "integer" },
      status: { type: "string", enum: ["auth_pending", "authorized", "auth_failed", "expired"] },
      tokenRefId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
      error: { anyOf: [{ type: "string" }, { type: "null" }] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "flowId",
      "requestedBy",
      "deviceCode",
      "userCode",
      "verificationUri",
      "verificationUriComplete",
      "expiresAt",
      "intervalSec",
      "status",
      "tokenRefId",
      "error",
      "createdAt",
      "updatedAt",
    ],
  } as const;

  const repoSummarySchema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      owner: { type: "string" },
      name: { type: "string" },
      fullName: { type: "string" },
      private: { type: "boolean" },
      defaultBranch: { type: "string" },
      htmlUrl: { type: "string" },
      cloneUrl: { type: "string" },
    },
    required: ["id", "owner", "name", "fullName", "private", "defaultBranch", "htmlUrl", "cloneUrl"],
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
    "/api/github/oauth/device/start",
    {
      schema: {
        tags: ["github-oauth"],
        summary: "Start GitHub device OAuth flow",
        headers: authHeaderSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  flowId: { type: "string", format: "uuid" },
                  userCode: { type: "string" },
                  verificationUri: { type: "string" },
                  verificationUriComplete: { anyOf: [{ type: "string" }, { type: "null" }] },
                  expiresAt: { type: "string", format: "date-time" },
                  interval: { type: "integer" },
                },
                required: [
                  "flowId",
                  "userCode",
                  "verificationUri",
                  "verificationUriComplete",
                  "expiresAt",
                  "interval",
                ],
              },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
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
    }
  );

  app.get(
    "/api/github/oauth/device/flows/:flowId",
    {
      schema: {
        tags: ["github-oauth"],
        summary: "Get GitHub OAuth device flow status",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            flowId: { type: "string", format: "uuid" },
          },
          required: ["flowId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: flowSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = flowIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const flow = await service.getFlowOrThrow(params.flowId, me.id);
      return reply.send({ ok: true, data: flow });
    }
  );

  app.get(
    "/api/github/oauth/repos",
    {
      schema: {
        tags: ["github-oauth"],
        summary: "List repositories available via GitHub OAuth",
        headers: authHeaderSchema,
        querystring: {
          type: "object",
          properties: {
            flowId: { type: "string", format: "uuid" },
          },
          required: ["flowId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: repoSummarySchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const query = listReposQuerySchema.parse(request.query);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const repos = await service.listRepos(query.flowId, me.id);
      return reply.send({ ok: true, data: repos });
    }
  );
};
