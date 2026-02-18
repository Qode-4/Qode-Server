import type { FastifyInstance } from "fastify";
import { createProjectBodySchema } from "./project.schema.js";
import {
  InMemoryProjectRepository,
  type ProjectRepository,
} from "./project.repository.js";
import { ProjectService } from "./project.service.js";

type RouteDeps = {
  repository?: ProjectRepository;
};

export const registerProjectRoutes = async (
  app: FastifyInstance,
  deps: RouteDeps = {}
) => {
  const repository = deps.repository ?? new InMemoryProjectRepository();
  const service = new ProjectService(repository);

  app.get("/api/projects", async (_request, reply) => {
    const data = await service.list();
    return reply.send({ ok: true, data });
  });
   
  app.post("/api/projects", async (request, reply) => {
    const body = createProjectBodySchema.parse(request.body);
    const data = await service.create(body);
    return reply.status(201).send({ ok: true, data });
  });
};
