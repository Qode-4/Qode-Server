import type { FastifyInstance } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { env } from "../../config/env.js";
import { loginBodySchema, signupBodySchema } from "./auth.schema.js";
import { InMemoryAuthRepository, type AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";

type RouteDeps = {
  repository?: AuthRepository;
};

const REFRESH_COOKIE_NAME = "refreshToken";

const getRefreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
});

const getRefreshCookieClearOptions = () => ({
  path: "/",
});

export const registerAuthRoutes = async (app: FastifyInstance, deps: RouteDeps = {}) => {
  const repository = deps.repository ?? new InMemoryAuthRepository();
  const service = new AuthService(repository);

  app.post("/auth/signup", async (request, reply) => {
    const body = signupBodySchema.parse(request.body);
    const data = await service.signupWithRefresh(body);
    reply.setCookie(REFRESH_COOKIE_NAME, data.refreshToken, getRefreshCookieOptions());
    return reply.status(201).send({ token: data.token, user: data.user });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginBodySchema.parse(request.body);
    const data = await service.loginWithRefresh(body);
    reply.setCookie(REFRESH_COOKIE_NAME, data.refreshToken, getRefreshCookieOptions());
    return reply.send({ token: data.token, user: data.user });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const data = await service.refresh(refreshToken);
    reply.setCookie(REFRESH_COOKIE_NAME, data.refreshToken, getRefreshCookieOptions());
    return reply.send({ token: data.token, user: data.user });
  });

  app.get("/auth/me", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const data = await service.getMe(token);
    return reply.send(data);
  });

  app.post("/auth/logout", async (request, reply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
    const authorization = request.headers.authorization;
    const accessToken =
      authorization && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : undefined;

    await service.logout(refreshToken, accessToken);
    reply.clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieClearOptions());
    return reply.status(204).send();
  });
};
