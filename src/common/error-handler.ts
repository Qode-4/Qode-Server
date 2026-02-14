import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "./http-error.js";

export const registerErrorHandler = (app: FastifyInstance) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        ok: false,
        error: "BAD_REQUEST",
        message: "Request validation failed",
        details: error.issues,
      });
    }

    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        ok: false,
        error: error.name,
        message: error.message,
        details: error.details,
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      ok: false,
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error",
    });
  });
};

