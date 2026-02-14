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
  const repository = deps.repository ?? new InMemorySampleItemRepository();
  const service = new SampleItemService(repository);

  app.get("/api/sample-items", async (_request, reply) => {
    const data = await service.list();
    return reply.send({ ok: true, data });
  });

  app.get("/api/sample-items/:id", async (request, reply) => {
    const params = sampleItemIdParamSchema.parse(request.params);
    const data = await service.getByIdOrThrow(params.id);
    return reply.send({ ok: true, data });
  });

  app.post("/api/sample-items", async (request, reply) => {
    const body = createSampleItemBodySchema.parse(request.body);
    const data = await service.create(body);
    return reply.status(201).send({ ok: true, data });
  });

  app.patch("/api/sample-items/:id", async (request, reply) => {
    const params = sampleItemIdParamSchema.parse(request.params);
    const body = updateSampleItemBodySchema.parse(request.body);
    const data = await service.updateOrThrow(params.id, body);
    return reply.send({ ok: true, data });
  });

  app.delete("/api/sample-items/:id", async (request, reply) => {
    const params = sampleItemIdParamSchema.parse(request.params);
    await service.deleteOrThrow(params.id);
    return reply.status(204).send();
  });
};
