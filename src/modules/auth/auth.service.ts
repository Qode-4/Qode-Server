import bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { HttpError } from "../../common/http-error.js";
import { env } from "../../config/env.js";
import { DuplicateEmailError, type AuthRepository } from "./auth.repository.js";
import type {
  AuthTokenBundle,
  AuthUser,
  LoginInput,
  LoginResult,
  MeResult,
  RefreshResult,
  SignupInput,
  SignupResult,
} from "./auth.types.js";

type RefreshPayload = {
  sub: string;
  jti: string;
  type: "refresh";
  tokenVersion: number;
};

type AccessPayload = {
  sub: string;
  tokenVersion: number;
};

export class AuthService {
  constructor(private readonly repository: AuthRepository) {}

  private toAuthUser(user: { id: string; email: string; name: string; avatarUrl: string | null }): AuthUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    };
  }

  private issueToken(user: AuthUser, tokenVersion: number): string {
    return jwt.sign(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        tokenVersion,
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"] }
    );
  }

  private hashRefreshToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private issueRefreshToken(
    userId: string,
    tokenVersion: number
  ): { refreshToken: string; sessionId: string } {
    const sessionId = crypto.randomUUID();
    const refreshToken = jwt.sign(
      {
        sub: userId,
        jti: sessionId,
        type: "refresh",
        tokenVersion,
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions["expiresIn"] }
    );

    return { refreshToken, sessionId };
  }

  private getRefreshExpiryIso(refreshToken: string): string {
    const decoded = jwt.decode(refreshToken);
    if (!decoded || typeof decoded === "string" || typeof decoded.exp !== "number") {
      throw new Error("Failed to decode refresh token expiration");
    }

    return new Date(decoded.exp * 1000).toISOString();
  }

  private async issueAuthTokenBundle(user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    tokenVersion: number;
  }): Promise<AuthTokenBundle> {
    const authUser = this.toAuthUser(user);
    const token = this.issueToken(authUser, user.tokenVersion);
    const { refreshToken, sessionId } = this.issueRefreshToken(user.id, user.tokenVersion);
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const expiresAt = this.getRefreshExpiryIso(refreshToken);

    await this.repository.createRefreshSession({
      id: sessionId,
      userId: authUser.id,
      tokenHash: refreshTokenHash,
      expiresAt,
    });

    return { token, user: authUser, refreshToken };
  }

  async signup(input: SignupInput): Promise<SignupResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const existingUser = await this.repository.findByEmail(normalizedEmail);
    if (existingUser) {
      throw new HttpError(409, "이미 가입된 이메일입니다.");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const createdUser = await this.repository.createUser({
      email: normalizedEmail,
      passwordHash,
      name: input.name.trim(),
    });

    const bundle = await this.issueAuthTokenBundle(createdUser);
    return { token: bundle.token, user: bundle.user };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.repository.findByEmail(normalizedEmail);
    if (!user) {
      throw new HttpError(401, "이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new HttpError(401, "이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    const bundle = await this.issueAuthTokenBundle(user);
    return { token: bundle.token, user: bundle.user };
  }

  async signupWithRefresh(input: SignupInput): Promise<AuthTokenBundle> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(input.password, 10);
    let createdUser;
    try {
      createdUser = await this.repository.createUser({
        email: normalizedEmail,
        passwordHash,
        name: input.name.trim(),
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        throw new HttpError(409, "이미 가입된 이메일입니다.");
      }
      throw error;
    }

    return this.issueAuthTokenBundle(createdUser);
  }

  async loginWithRefresh(input: LoginInput): Promise<AuthTokenBundle> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.repository.findByEmail(normalizedEmail);
    if (!user) {
      throw new HttpError(401, "이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new HttpError(401, "이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    return this.issueAuthTokenBundle(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokenBundle> {
    let payload: RefreshPayload;
    try {
      payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as RefreshPayload;
    } catch {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    if (payload.type !== "refresh" || !payload.sub || !payload.jti) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const user = await this.repository.findById(payload.sub);
    if (!user) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    if (payload.tokenVersion !== user.tokenVersion) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const tokenHash = this.hashRefreshToken(refreshToken);
    const consumed = await this.repository.consumeRefreshSession({
      id: payload.jti,
      userId: payload.sub,
      tokenHash,
    });
    if (!consumed) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    return this.issueAuthTokenBundle(user);
  }

  async logout(refreshToken?: string, accessToken?: string): Promise<void> {
    let userId: string | undefined;

    if (refreshToken) {
      try {
        const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as RefreshPayload;
        if (payload.type === "refresh" && payload.sub) {
          userId = payload.sub;
        }
      } catch {
        // ignore
      }
    }

    if (!userId && accessToken) {
      try {
        const payload = jwt.verify(accessToken, env.JWT_SECRET) as AccessPayload;
        if (payload.sub) {
          userId = payload.sub;
        }
      } catch {
        // ignore
      }
    }

    if (!userId) {
      return;
    }

    await this.repository.incrementTokenVersion(userId);
    await this.repository.revokeAllRefreshSessionsByUserId(userId);
  }

  async getMe(token: string): Promise<MeResult> {
    let payload: AccessPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as AccessPayload;
    } catch {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    if (!payload.sub) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    const user = await this.repository.findById(payload.sub);
    if (!user) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    if (payload.tokenVersion !== user.tokenVersion) {
      throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
    }

    return {
      id: user.id,
      token,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    };
  }
}
