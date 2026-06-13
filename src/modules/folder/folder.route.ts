import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import { AuthService } from "../auth/auth.service.js";
import type { ProjectRepository } from "../project/project.repository.js";
import type { SectionRepository } from "../section/section.repository.js";
import {
  createFolderBodySchema,
  folderIdParamSchema,
  sectionIdParamSchema,
  updateFolderBodySchema,
} from "./folder.schema.js";
import { FolderService } from "./folder.service.js";
import type { FolderRepository } from "./folder.repository.js";

type RouteDeps = {
  repository: FolderRepository;
  sectionRepository: SectionRepository;
  projectRepository: ProjectRepository;
  authRepository: AuthRepository;
};

export const registerFolderRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps
) => {
  const authService = new AuthService(deps.authRepository);
  const service = new FolderService(deps.repository, deps.sectionRepository, deps.projectRepository);

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
    "/api/sections/:sectionId/folders",
    {
      schema: {
        tags: ["folder"],
        summary: "Create a folder",
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
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: folderSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = sectionIdParamSchema.parse(request.params);
      const body = createFolderBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.create(params.sectionId, body, me.id);
      return reply.status(201).send({ ok: true, data });
    }
  );

  app.patch(
    "/api/folders/:folderId",
    {
      schema: {
        tags: ["folder"],
        summary: "Update a folder name",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            folderId: { type: "string", format: "uuid" },
          },
          required: ["folderId"],
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
              data: folderSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = folderIdParamSchema.parse(request.params);
      const body = updateFolderBodySchema.parse(request.body);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      const data = await service.updateOrThrow(params.folderId, body, me.id);
      return reply.send({ ok: true, data });
    }
  );

  app.delete(
    "/api/folders/:folderId",
    {
      schema: {
        tags: ["folder"],
        summary: "Delete a folder",
        headers: authHeaderSchema,
        params: {
          type: "object",
          properties: {
            folderId: { type: "string", format: "uuid" },
          },
          required: ["folderId"],
        },
        response: {
          204: {
            type: "null",
          },
        },
      },
    },
    async (request, reply) => {
      const params = folderIdParamSchema.parse(request.params);
      const token = getAccessToken(request.headers.authorization);
      const me = await authService.getMe(token);
      await service.deleteOrThrow(params.folderId, me.id);
      return reply.status(204).send();
    }
  );
};
