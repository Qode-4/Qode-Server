import type { FastifyInstance } from "fastify";
import {
  createSampleItemBodySchema,
  sampleItemIdParamSchema,
  updateSampleItemBodySchema,
} from "./sample-item.schema.js";
import {
  InMemorySampleItemRepository,
  type SampleItemRepository,
} from "./sample-item.repository.js";
import { SampleItemService } from "./sample-item.service.js";

type RouteDeps = {
  repository?: SampleItemRepository;
};

export const registerSampleItemRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps = {}
) => {
  // 별도 설정이 없으면 로컬 실행을 위해 메모리 저장소를 기본 사용합니다.
  const repository = deps.repository ?? new InMemorySampleItemRepository();
  const service = new SampleItemService(repository);

  const sampleItemSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      title: { type: "string" },
      description: { anyOf: [{ type: "string" }, { type: "null" }] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "title", "description", "createdAt", "updatedAt"],
  } as const;

  app.get(
    "/api/sample-items",
    {
      schema: {
        tags: ["sample-item"],
        summary: "List sample items",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "array", items: sampleItemSchema },
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (_request, reply) => {
      const data = await service.list();
      return reply.send({ ok: true, data });
    }
  );

  app.get(
    "/api/sample-items/:id",
    {
      schema: {
        tags: ["sample-item"],
        summary: "Get sample item by id",
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
              data: sampleItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = sampleItemIdParamSchema.parse(request.params);
      const data = await service.getByIdOrThrow(params.id);
      return reply.send({ ok: true, data });
    }
  );

  app.post(
    "/api/sample-items",
    {
      schema: {
        tags: ["sample-item"],
        summary: "Create sample item",
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["title"],
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: sampleItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const body = createSampleItemBodySchema.parse(request.body);
      const data = await service.create(body);
      return reply.status(201).send({ ok: true, data });
    }
  );

  app.patch(
    "/api/sample-items/:id",
    {
      schema: {
        tags: ["sample-item"],
        summary: "Update sample item",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: "string", minLength: 1, maxLength: 1000 },
          },
          minProperties: 1,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: sampleItemSchema,
            },
            required: ["ok", "data"],
          },
        },
      },
    },
    async (request, reply) => {
      const params = sampleItemIdParamSchema.parse(request.params);
      const body = updateSampleItemBodySchema.parse(request.body);
      const data = await service.updateOrThrow(params.id, body);
      return reply.send({ ok: true, data });
    }
  );

  app.delete(
    "/api/sample-items/:id",
    {
      schema: {
        tags: ["sample-item"],
        summary: "Delete sample item",
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
        },
        response: {
          204: {
            description: "No content",
            type: "null",
          },
        },
      },
    },
    async (request, reply) => {
      const params = sampleItemIdParamSchema.parse(request.params);
      await service.deleteOrThrow(params.id);
      return reply.status(204).send();
    }
  );
};
