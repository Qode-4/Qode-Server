import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import {
  InMemoryAuthRepository,
  type AuthRepository,
} from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import type { ProjectRepository } from "../project/project.repository.js";
import { InMemoryProjectRepository } from "../project/project.repository.js";
import {
  InMemoryStorageItemRepository,
  type StorageItemRepository,
} from "./storage-item.repository.js";
import {
  createStorageItemBodySchema,
  storageItemIdParamSchema,
  storageItemProjectParamSchema,
  updateStorageItemBodySchema,
} from "./storage-item.schema.js";
import { StorageItemService } from "./storage-item.service.js";

type RouteDeps = {
  repository?: StorageItemRepository;
  projectRepository?: ProjectRepository;
  authRepository?: AuthRepository;
};

export const registerStorageItemRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps = {}
) => {
  const repository = deps.repository ?? new InMemoryStorageItemRepository();
  const projectRepository = deps.projectRepository ?? new InMemoryProjectRepository();
  const authRepository = deps.authRepository ?? new InMemoryAuthRepository();
  const authService = new AuthService(authRepository);
  const service = new StorageItemService(repository, projectRepository);

  const authHeaderSchema = {
    type: "object",
    properties: {
      authorization: { type: "string" },
    },
    required: ["authorization"],
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

  const storageItemSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      type: { type: "string", enum: ["github_repo", "figma", "figjam"] },
      title: { type: "string" },
      url: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
      createdBy: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          avatarUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["id", "name", "avatarUrl"],
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "projectId",
      "type",
      "title",
      "url",
      "metadata",
      "createdBy",
      "createdAt",
      "updatedAt",
    ],
  } as const;

  const projectParamsSchema = {
    type: "object",
    properties: {
      projectId: { type: "string", format: "uuid" },
    },
    required: ["projectId"],
  } as const;

  const itemParamsSchema = {
    type: "object",
    properties: {
      projectId: { type: "string", format: "uuid" },
      id: { type: "string", format: "uuid" },
    },
    required: ["projectId", "id"],
  } as const;

  const createBodySchema = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["github_repo", "figma", "figjam"] },
      title: { type: "string", minLength: 1, maxLength: 200 },
      url: { type: "string", minLength: 1 },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["type", "title", "url", "metadata"],
  } as const;

  const updateBodySchema = {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["title"],
  } as const;

  app.get(
    "/api/projects/:projectId/storage-items",
    {
      schema: {
        tags: ["storage-item"],
        summary: "List storage items for a project",
        headers: authHeaderSchema,
        params: projectParamsSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: storageItemSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = storageItemProjectParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.list(params.projectId, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.get(
    "/api/projects/:projectId/storage-items/:id",
    {
      schema: {
        tags: ["storage-item"],
        summary: "Get a storage item by id",
        headers: authHeaderSchema,
        params: itemParamsSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: storageItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = storageItemIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.getByIdOrThrow(params.projectId, params.id, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.post(
    "/api/projects/:projectId/storage-items",
    {
      schema: {
        tags: ["storage-item"],
        summary: "Create a storage item",
        headers: authHeaderSchema,
        params: projectParamsSchema,
        body: createBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: storageItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = storageItemProjectParamSchema.parse(request.params);
      const body = createStorageItemBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.create(params.projectId, body, {
        id: me.id,
        name: me.name,
        avatarUrl: me.avatarUrl,
      });
      return reply.status(201).send({ ok: true, data });
    }
  );

  app.patch(
    "/api/projects/:projectId/storage-items/:id",
    {
      schema: {
        tags: ["storage-item"],
        summary: "Update a storage item title",
        headers: authHeaderSchema,
        params: itemParamsSchema,
        body: updateBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: storageItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = storageItemIdParamSchema.parse(request.params);
      const body = updateStorageItemBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.updateOrThrow(
        params.projectId,
        params.id,
        body,
        me.id
      );
      return reply.send({ ok: true, data });
    }
  );

  app.delete(
    "/api/projects/:projectId/storage-items/:id",
    {
      schema: {
        tags: ["storage-item"],
        summary: "Delete a storage item",
        headers: authHeaderSchema,
        params: itemParamsSchema,
        response: {
          204: {
            type: "null",
          },
        },
      },
    },
    async (request, reply) => {
      const params = storageItemIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      await service.deleteOrThrow(params.projectId, params.id, me.id);
      return reply.status(204).send();
    }
  );
};
