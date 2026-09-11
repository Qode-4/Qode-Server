import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import type { ProjectRepository } from "../project/project.repository.js";
import {
  createSectionBodySchema,
  projectSectionParamSchema,
  sectionIdParamSchema,
  updateSectionBodySchema,
} from "./section.schema.js";
import type { SectionRepository } from "./section.repository.js";
import { SectionService } from "./section.service.js";

type RouteDeps = {
  repository: SectionRepository;
  projectRepository: ProjectRepository;
  authRepository: AuthRepository;
};

export const registerSectionRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps
) => {
  const authService = new AuthService(deps.authRepository);
  const service = new SectionService(deps.repository, deps.projectRepository);

  const authHeaderSchema = {
    type: "object",
    properties: {
      authorization: { type: "string" },
    },
    required: ["authorization"],
  } as const;

  const folderSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      sectionId: { type: "string", format: "uuid" },
      name: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "sectionId", "name", "createdAt", "updatedAt"],
  } as const;

  const sectionTreeSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      name: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      folders: { type: "array", items: folderSchema },
    },
    required: ["id", "projectId", "name", "createdAt", "updatedAt", "folders"],
  } as const;

  const sectionSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      name: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "projectId", "name", "createdAt", "updatedAt"],
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
    "/api/projects/:projectId/sections",
    {
      schema: {
        tags: ["section"],
        summary: "List section tree for a project",
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
              data: { type: "array", items: sectionTreeSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectSectionParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.listTree(params.projectId, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.post(
    "/api/projects/:projectId/sections",
    {
      schema: {
        tags: ["section"],
        summary: "Create a section",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
          },
          required: ["projectId"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
          },
          required: ["name"],
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: sectionSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = projectSectionParamSchema.parse(request.params);
      const body = createSectionBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.create(params.projectId, body, me.id);
      return reply.status(201).send({ ok: true, data });
    }
  );

  app.patch(
    "/api/sections/:sectionId",
    {
      schema: {
        tags: ["section"],
        summary: "Update a section name",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            sectionId: { type: "string", format: "uuid" },
          },
          required: ["sectionId"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
          },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: sectionSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = sectionIdParamSchema.parse(request.params);
      const body = updateSectionBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.updateOrThrow(params.sectionId, body, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.delete(
    "/api/sections/:sectionId",
    {
      schema: {
        tags: ["section"],
        summary: "Delete a section",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            sectionId: { type: "string", format: "uuid" },
          },
          required: ["sectionId"],
        },
        response: {
          204: {
            type: "null",
          },
        },
      },
    },
    async (request, reply) => {
      const params = sectionIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      await service.deleteOrThrow(params.sectionId, me.id);
      return reply.status(204).send();
    }
  );
};
