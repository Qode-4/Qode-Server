import type { FastifyReply, FastifyRequest } from "fastify";

import { HttpError } from "./http-error.js";
import { env } from "../config/env.js";

export type SseContext = {
  /** 이벤트 전송. 연결이 이미 끊겼으면 조용히 무시한다. */
  send: (event: string, data: unknown) => void;
  /** 클라이언트가 연결을 끊으면 abort 된다. LLM 호출까지 전달할 것. */
  signal: AbortSignal;
};

const toSsePayload = (error: unknown) => {
  const message =
    error instanceof HttpError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unexpected streaming error";

  const details = error instanceof HttpError ? error.details : undefined;
  const code =
    details && typeof details === "object" && "code" in details
      ? (details as { code?: unknown }).code
      : undefined;

  return { message, code, details };
};

/**
 * SSE 응답의 공통 뼈대.
 *
 * chat.route.ts 에 흩어져 있던 다음 문제를 한 곳에서 해결한다.
 *  - reply.hijack() 누락으로 Fastify 라이프사이클이 꼬이는 문제
 *  - 리버스 프록시 버퍼링(X-Accel-Buffering)
 *  - 클라이언트 연결 종료 감지 부재 → LLM 토큰 과금 누수
 *  - catch 내부 await 실패 시 error 이벤트가 나가지 않던 문제
 *    (여기서는 send("error")를 먼저 하고, DB 정리는 onError 에서 한다)
 *  - 이미 end() 된 소켓에 write 하여 터지는 문제
 */
export const streamSse = async (
  request: FastifyRequest,
  reply: FastifyReply,
  handler: (ctx: SseContext) => Promise<void>,
  options?: {
    /** error 이벤트를 보낸 뒤 실행되는 정리 훅. 여기서 던져도 응답에는 영향 없다. */
    onError?: (error: unknown) => Promise<void>;
  }
) => {
  reply.hijack();

  const origin = request.headers.origin;
  if (origin && env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    reply.raw.setHeader("Vary", "Origin");
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
  }
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  // nginx 등 프록시 뒤에서 응답이 버퍼링되어 "스트리밍인데 한 번에 나오는" 현상 방지
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders?.();

  const abort = new AbortController();
  const onClose = () => abort.abort();
  request.raw.on("close", onClose);

  const send = (event: string, data: unknown) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 프록시가 유휴 연결을 끊지 않도록 하는 주석 프레임(SSE 스펙상 ':' 로 시작하면 무시된다)
  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`: ping\n\n`);
  }, 15_000);

  try {
    await handler({ send, signal: abort.signal });
  } catch (error) {
    // 순서 중요: 사용자에게 먼저 알리고, 정리는 그 다음이다.
    send("error", toSsePayload(error));
    if (options?.onError) {
      try {
        await options.onError(error);
      } catch (cleanupError) {
        request.log.error({ err: cleanupError }, "SSE cleanup failed");
      }
    }
    request.log.error({ err: error }, "SSE stream failed");
  } finally {
    clearInterval(heartbeat);
    request.raw.off("close", onClose);
    reply.raw.end();
  }
};