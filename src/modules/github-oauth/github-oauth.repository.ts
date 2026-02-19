import type { Pool } from "pg";

export type GithubOauthFlowStatus = "auth_pending" | "authorized" | "auth_failed" | "expired";

export type GithubOauthDeviceFlow = {
  flowId: string;
  requestedBy: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  intervalSec: number;
  status: GithubOauthFlowStatus;
  tokenRefId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GithubOauthToken = {
  id: string;
  userId: string;
  githubUserId: number;
  githubLogin: string;
  accessTokenEncrypted: string;
  scope: string;
  expiresAt: string | null;
};

type FlowRow = {
  flow_id: string;
  requested_by: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  expires_at: Date;
  interval_sec: number;
  status: GithubOauthFlowStatus;
  token_ref_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

type TokenRow = {
  id: string;
  user_id: string;
  github_user_id: string;
  github_login: string;
  access_token_encrypted: string;
  scope: string;
  expires_at: Date | null;
};

const toFlow = (row: FlowRow): GithubOauthDeviceFlow => ({
  flowId: row.flow_id,
  requestedBy: row.requested_by,
  deviceCode: row.device_code,
  userCode: row.user_code,
  verificationUri: row.verification_uri,
  verificationUriComplete: row.verification_uri_complete,
  expiresAt: row.expires_at.toISOString(),
  intervalSec: row.interval_sec,
  status: row.status,
  tokenRefId: row.token_ref_id,
  error: row.error,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toToken = (row: TokenRow): GithubOauthToken => ({
  id: row.id,
  userId: row.user_id,
  githubUserId: Number(row.github_user_id),
  githubLogin: row.github_login,
  accessTokenEncrypted: row.access_token_encrypted,
  scope: row.scope,
  expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
});

export class PgGithubOauthRepository {
  constructor(private readonly pool: Pool) {}

  async expireActiveFlowsByUser(userId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE github_oauth_device_flows
      SET status = 'expired', updated_at = NOW()
      WHERE requested_by = $1 AND status = 'auth_pending'
      `,
      [userId]
    );
  }

  async createFlow(input: {
    flowId: string;
    requestedBy: string;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string | null;
    expiresAt: string;
    intervalSec: number;
  }): Promise<GithubOauthDeviceFlow> {
    const result = await this.pool.query<FlowRow>(
      `
      INSERT INTO github_oauth_device_flows (
        flow_id, requested_by, device_code, user_code, verification_uri,
        verification_uri_complete, expires_at, interval_sec, status, token_ref_id, error, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, 'auth_pending', NULL, NULL, NOW(), NOW())
      RETURNING *
      `,
      [
        input.flowId,
        input.requestedBy,
        input.deviceCode,
        input.userCode,
        input.verificationUri,
        input.verificationUriComplete,
        input.expiresAt,
        input.intervalSec,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create OAuth flow");
    }
    return toFlow(row);
  }

  async findFlowById(flowId: string): Promise<GithubOauthDeviceFlow | null> {
    const result = await this.pool.query<FlowRow>(
      `
      SELECT *
      FROM github_oauth_device_flows
      WHERE flow_id = $1
      LIMIT 1
      `,
      [flowId]
    );
    const row = result.rows[0];
    return row ? toFlow(row) : null;
  }

  async markFlowExpired(flowId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE github_oauth_device_flows
      SET status = 'expired', updated_at = NOW()
      WHERE flow_id = $1 AND status = 'auth_pending'
      `,
      [flowId]
    );
  }

  async markFlowFailed(flowId: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE github_oauth_device_flows
      SET status = 'auth_failed', error = $2, updated_at = NOW()
      WHERE flow_id = $1
      `,
      [flowId, error]
    );
  }

  async markFlowAuthorized(flowId: string, tokenRefId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE github_oauth_device_flows
      SET status = 'authorized', token_ref_id = $2, error = NULL, updated_at = NOW()
      WHERE flow_id = $1
      `,
      [flowId, tokenRefId]
    );
  }

  async upsertToken(input: {
    userId: string;
    githubUserId: number;
    githubLogin: string;
    accessTokenEncrypted: string;
    scope: string;
    expiresAt: string | null;
  }): Promise<GithubOauthToken> {
    const id = crypto.randomUUID();
    const result = await this.pool.query<TokenRow>(
      `
      INSERT INTO github_oauth_tokens (
        id, user_id, github_user_id, github_login, access_token_encrypted,
        refresh_token_encrypted, scope, expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::timestamptz, NOW(), NOW())
      ON CONFLICT (user_id, github_user_id) DO UPDATE
      SET
        github_login = EXCLUDED.github_login,
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        scope = EXCLUDED.scope,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      RETURNING id, user_id, github_user_id, github_login, access_token_encrypted, scope, expires_at
      `,
      [
        id,
        input.userId,
        input.githubUserId,
        input.githubLogin,
        input.accessTokenEncrypted,
        input.scope,
        input.expiresAt,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to upsert OAuth token");
    }
    return toToken(row);
  }

  async findTokenById(tokenId: string): Promise<GithubOauthToken | null> {
    const result = await this.pool.query<TokenRow>(
      `
      SELECT id, user_id, github_user_id, github_login, access_token_encrypted, scope, expires_at
      FROM github_oauth_tokens
      WHERE id = $1
      LIMIT 1
      `,
      [tokenId]
    );
    const row = result.rows[0];
    return row ? toToken(row) : null;
  }
}
