import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "./http-error.js";

type FastifyValidationError = Error & {
  validation: unknown;
  validationContext?: string;
};

const isFastifyValidationError = (error: unknown): error is FastifyValidationError =>
  error instanceof Error && Array.isArray((error as { validation?: unknown }).validation);

export const registerErrorHandler = (app: FastifyInstance) => {
  // 발생한 모든 에러를 일관된 API 응답 형식으로 정규화합니다.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        status: 400,
        ok: false,
        error: "BAD_REQUEST",
        message: "Request validation failed",
        details: error.issues,
      });
    }

    if (isFastifyValidationError(error)) {
      return reply.status(400).send({
        status: 400,
        ok: false,
        error: "BAD_REQUEST",
        message: error.message,
        details: error.validation,
      });
    }

    if (error instanceof HttpError) {
      const codedDetails =
        error.details &&
        typeof error.details === "object" &&
        "code" in error.details &&
        typeof (error.details as { code?: unknown }).code === "string"
          ? (error.details as { code: string }).code
          : null;

      return reply.status(error.statusCode).send({
        status: error.statusCode,
        ok: false,
        error: codedDetails ?? error.name,
        message: error.message,
        details: error.details,
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      status: 500,
      ok: false,
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error",
    });
  });
};
