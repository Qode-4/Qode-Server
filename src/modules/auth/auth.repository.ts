import type { Pool } from "pg";
import type { DatabaseError } from "pg";
import type { AuthUserWithPassword } from "./auth.types.js";

export interface AuthRepository {
  findByEmail(email: string): Promise<AuthUserWithPassword | null>;
  findById(id: string): Promise<AuthUserWithPassword | null>;
  createUser(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<AuthUserWithPassword>;
  createRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void>;
  findActiveRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
  }): Promise<boolean>;
  consumeRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
  }): Promise<boolean>;
  revokeRefreshSession(id: string): Promise<void>;
  revokeAllRefreshSessionsByUserId(userId: string): Promise<void>;
  incrementTokenVersion(userId: string): Promise<void>;
}

export class DuplicateEmailError extends Error {
  constructor() {
    super("Duplicate email");
    this.name = "DuplicateEmailError";
  }
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly usersByEmail = new Map<string, AuthUserWithPassword>();
  private readonly usersById = new Map<string, AuthUserWithPassword>();
  private readonly refreshSessions = new Map<
    string,
    { userId: string; tokenHash: string; expiresAt: string; revokedAt: string | null }
  >();

  async findByEmail(email: string): Promise<AuthUserWithPassword | null> {
    return this.usersByEmail.get(email) ?? null;
  }

  async findById(id: string): Promise<AuthUserWithPassword | null> {
    return this.usersById.get(id) ?? null;
  }

  async createUser(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<AuthUserWithPassword> {
    if (this.usersByEmail.has(input.email)) {
      throw new DuplicateEmailError();
    }

    const user: AuthUserWithPassword = {
      id: crypto.randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      name: input.name,
      avatarUrl: null,
      tokenVersion: 0,
    };

    this.usersByEmail.set(input.email, user);
    this.usersById.set(user.id, user);
    return user;
  }

  async createRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void> {
    this.refreshSessions.set(input.id, {
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
  }

  async findActiveRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
  }): Promise<boolean> {
    const session = this.refreshSessions.get(input.id);
    if (!session) {
      return false;
    }

    if (session.userId !== input.userId || session.tokenHash !== input.tokenHash) {
      return false;
    }

    if (session.revokedAt !== null) {
      return false;
    }

    return new Date(session.expiresAt).getTime() > Date.now();
  }

  async consumeRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
  }): Promise<boolean> {
    const session = this.refreshSessions.get(input.id);
    if (!session) {
      return false;
    }

    if (session.userId !== input.userId || session.tokenHash !== input.tokenHash) {
      return false;
    }

    if (session.revokedAt !== null) {
      return false;
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      return false;
    }

    this.refreshSessions.set(input.id, {
      ...session,
      revokedAt: new Date().toISOString(),
    });
    return true;
  }

  async revokeRefreshSession(id: string): Promise<void> {
    const session = this.refreshSessions.get(id);
    if (!session) {
      return;
    }

    this.refreshSessions.set(id, {
      ...session,
      revokedAt: new Date().toISOString(),
    });
  }

  async revokeAllRefreshSessionsByUserId(userId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const [sessionId, session] of this.refreshSessions.entries()) {
      if (session.userId !== userId || session.revokedAt !== null) {
        continue;
      }

      this.refreshSessions.set(sessionId, {
        ...session,
        revokedAt: now,
      });
    }
  }

  async incrementTokenVersion(userId: string): Promise<void> {
    const current = this.usersById.get(userId);
    if (!current) {
      return;
    }

    const next: AuthUserWithPassword = {
      ...current,
      tokenVersion: current.tokenVersion + 1,
    };

    this.usersById.set(userId, next);
    this.usersByEmail.set(next.email, next);
  }
}

type UserRow = {
  id: string;
  email: string;
  password: string;
  name: string;
  avatar_url: string | null;
  token_version: number;
};

const toAuthUserWithPassword = (row: UserRow): AuthUserWithPassword => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password,
  name: row.name,
  avatarUrl: row.avatar_url,
  tokenVersion: row.token_version,
});

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<AuthUserWithPassword | null> {
    const result = await this.pool.query<UserRow>(
      `
      SELECT id, email, password, name, avatar_url, token_version
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return toAuthUserWithPassword(row);
  }

  async findById(id: string): Promise<AuthUserWithPassword | null> {
    const result = await this.pool.query<UserRow>(
      `
      SELECT id, email, password, name, avatar_url, token_version
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return toAuthUserWithPassword(row);
  }

  async createUser(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<AuthUserWithPassword> {
    const id = crypto.randomUUID();
    let result;
    try {
      result = await this.pool.query<UserRow>(
        `
        INSERT INTO users (id, email, password, name, avatar_url, created_at, token_version)
        VALUES ($1, $2, $3, $4, NULL, NOW(), 0)
        RETURNING id, email, password, name, avatar_url, token_version
        `,
        [id, input.email, input.passwordHash, input.name]
      );
    } catch (error) {
      const dbError = error as DatabaseError;
      if (dbError.code === "23505") {
        throw new DuplicateEmailError();
      }
      throw error;
    }

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create user");
    }

    return toAuthUserWithPassword(row);
  }

  async createRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at)
      VALUES ($1, $2, $3, $4, NULL, NOW())
      `,
      [input.id, input.userId, input.tokenHash, input.expiresAt]
    );
  }

  async findActiveRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
  }): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM user_refresh_tokens
        WHERE id = $1
          AND user_id = $2
          AND token_hash = $3
          AND revoked_at IS NULL
          AND expires_at > NOW()
      ) AS exists
      `,
      [input.id, input.userId, input.tokenHash]
    );

    return result.rows[0]?.exists ?? false;
  }

  async consumeRefreshSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE user_refresh_tokens
      SET revoked_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND token_hash = $3
        AND revoked_at IS NULL
        AND expires_at > NOW()
      RETURNING id
      `,
      [input.id, input.userId, input.tokenHash]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async revokeRefreshSession(id: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE user_refresh_tokens
      SET revoked_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      `,
      [id]
    );
  }

  async revokeAllRefreshSessionsByUserId(userId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE user_refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
      `,
      [userId]
    );
  }

  async incrementTokenVersion(userId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE users
      SET token_version = token_version + 1
      WHERE id = $1
      `,
      [userId]
    );
  }
}
