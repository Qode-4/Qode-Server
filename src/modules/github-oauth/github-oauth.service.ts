import { HttpError } from "../../common/http-error.js";
import { env } from "../../config/env.js";
import { decryptSecret, encryptSecret } from "../../lib/secret-crypto.js";
import {
  type GithubOauthDeviceFlow,
  type GithubOauthToken,
  PgGithubOauthRepository,
} from "./github-oauth.repository.js";

type GithubTokenPollingResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
};

type GithubUserResponse = {
  id: number;
  login: string;
};

export type GithubRepoSummary = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
};

export class GithubOauthService {
  private readonly pollingFlowIds = new Set<string>();

  constructor(private readonly repository: PgGithubOauthRepository) {}

  private async githubRequest<T>(
    url: string,
    options?: { method?: string; body?: URLSearchParams; token?: string }
  ): Promise<T> {
    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers: {
        Accept: "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options?.body,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new HttpError(424, "GitHub API 호출에 실패했습니다.", {
        code: "GITHUB_API_FAILED",
        status: response.status,
        body: bodyText.slice(0, 300),
      });
    }

    return (await response.json()) as T;
  }

  async startDeviceFlow(userId: string): Promise<GithubOauthDeviceFlow> {
    await this.repository.expireActiveFlowsByUser(userId);
    const body = new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      scope: env.GITHUB_OAUTH_SCOPES,
    });

    const response = await this.githubRequest<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      expires_in: number;
      interval: number;
    }>("https://github.com/login/device/code", {
      method: "POST",
      body,
    });

    const now = Date.now();
    const flow = await this.repository.createFlow({
      flowId: crypto.randomUUID(),
      requestedBy: userId,
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
      verificationUriComplete: response.verification_uri_complete ?? null,
      expiresAt: new Date(now + response.expires_in * 1000).toISOString(),
      intervalSec: response.interval,
    });

    this.startPolling(flow.flowId);
    return flow;
  }

  async getFlowOrThrow(flowId: string, userId: string): Promise<GithubOauthDeviceFlow> {
    const flow = await this.repository.findFlowById(flowId);
    if (!flow) {
      throw new HttpError(404, "OAuth flow를 찾을 수 없습니다.", { code: "GITHUB_OAUTH_FLOW_NOT_FOUND" });
    }
    if (flow.requestedBy !== userId) {
      throw new HttpError(403, "권한이 없습니다.", { code: "GITHUB_OAUTH_FORBIDDEN" });
    }

    if (flow.status === "auth_pending" && new Date(flow.expiresAt).getTime() <= Date.now()) {
      await this.repository.markFlowExpired(flow.flowId);
      const refreshed = await this.repository.findFlowById(flow.flowId);
      if (!refreshed) {
        throw new HttpError(404, "OAuth flow를 찾을 수 없습니다.", {
          code: "GITHUB_OAUTH_FLOW_NOT_FOUND",
        });
      }
      return refreshed;
    }

    return flow;
  }

  async listRepos(flowId: string, userId: string): Promise<GithubRepoSummary[]> {
    const flow = await this.getFlowOrThrow(flowId, userId);
    if (flow.status !== "authorized" || !flow.tokenRefId) {
      throw new HttpError(401, "OAuth 승인이 완료되지 않았습니다.", {
        code: "GITHUB_OAUTH_PENDING_OR_EXPIRED",
      });
    }

    const tokenRow = await this.repository.findTokenById(flow.tokenRefId);
    if (!tokenRow) {
      throw new HttpError(401, "OAuth 토큰이 유효하지 않습니다.", {
        code: "GITHUB_OAUTH_TOKEN_INVALID",
      });
    }

    const token = decryptSecret(tokenRow.accessTokenEncrypted, env.TOKEN_ENCRYPTION_KEY);
    const allRepos: GithubRepoSummary[] = [];
    let page = 1;

    while (true) {
      const repos = await this.githubRequest<
        Array<{
          id: number;
          owner: { login: string };
          name: string;
          full_name: string;
          private: boolean;
          default_branch: string;
          html_url: string;
          clone_url: string;
        }>
      >(
        `https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`,
        { token }
      );

      allRepos.push(
        ...repos.map((repo) => ({
          id: repo.id,
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          htmlUrl: repo.html_url,
          cloneUrl: repo.clone_url,
        }))
      );

      if (repos.length < 100) {
        break;
      }
      page += 1;
    }

    return allRepos;
  }

  async verifyRepoAccess(input: {
    tokenRefId: string;
    owner: string;
    repo: string;
  }): Promise<{ gitUrl: string; defaultBranch: string }> {
    const tokenRow = await this.repository.findTokenById(input.tokenRefId);
    if (!tokenRow) {
      throw new HttpError(424, "GitHub OAuth 토큰이 유효하지 않습니다. 다시 인증해 주세요.", {
        code: "GITHUB_OAUTH_TOKEN_INVALID",
      });
    }
    if (tokenRow.expiresAt && new Date(tokenRow.expiresAt).getTime() <= Date.now()) {
      throw new HttpError(424, "GitHub OAuth 토큰이 만료되었습니다. 다시 인증해 주세요.", {
        code: "GITHUB_OAUTH_TOKEN_EXPIRED",
      });
    }

    const token = decryptSecret(tokenRow.accessTokenEncrypted, env.TOKEN_ENCRYPTION_KEY);
    const repo = await this.githubRequest<{
      clone_url: string;
      default_branch: string;
    }>(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`, {
      token,
    });

    return {
      gitUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
    };
  }

  async getAuthorizedTokenRefIdOrThrow(flowId: string, userId: string): Promise<string> {
    const flow = await this.getFlowOrThrow(flowId, userId);
    if (flow.status !== "authorized" || !flow.tokenRefId) {
      throw new HttpError(401, "OAuth 승인이 완료되지 않았습니다.", {
        code: "GITHUB_OAUTH_PENDING_OR_EXPIRED",
      });
    }
    return flow.tokenRefId;
  }

  async getTokenById(tokenRefId: string): Promise<GithubOauthToken | null> {
    return this.repository.findTokenById(tokenRefId);
  }

  private startPolling(flowId: string): void {
    if (this.pollingFlowIds.has(flowId)) {
      return;
    }
    this.pollingFlowIds.add(flowId);
    void this.pollForToken(flowId).finally(() => {
      this.pollingFlowIds.delete(flowId);
    });
  }

  private async pollForToken(flowId: string): Promise<void> {
    let intervalSec = 5;
    while (true) {
      const flow = await this.repository.findFlowById(flowId);
      if (!flow) {
        return;
      }
      if (flow.status !== "auth_pending") {
        return;
      }
      if (new Date(flow.expiresAt).getTime() <= Date.now()) {
        await this.repository.markFlowExpired(flowId);
        return;
      }

      intervalSec = Math.max(intervalSec, flow.intervalSec);
      await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));

      const body = new URLSearchParams({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });

      let tokenResponse: GithubTokenPollingResponse;
      try {
        tokenResponse = await this.githubRequest<GithubTokenPollingResponse>(
          "https://github.com/login/oauth/access_token",
          { method: "POST", body }
        );
      } catch (error) {
        await this.repository.markFlowFailed(flowId, error instanceof Error ? error.message : "OAuth polling failed");
        return;
      }

      if (tokenResponse.error === "authorization_pending") {
        continue;
      }
      if (tokenResponse.error === "slow_down") {
        intervalSec += 5;
        continue;
      }
      if (tokenResponse.error === "expired_token") {
        await this.repository.markFlowExpired(flowId);
        return;
      }
      if (tokenResponse.error === "access_denied") {
        await this.repository.markFlowFailed(flowId, "access_denied");
        return;
      }
      if (!tokenResponse.access_token) {
        await this.repository.markFlowFailed(flowId, tokenResponse.error ?? "token_missing");
        return;
      }

      const user = await this.githubRequest<GithubUserResponse>("https://api.github.com/user", {
        token: tokenResponse.access_token,
      });
      const encryptedToken = encryptSecret(tokenResponse.access_token, env.TOKEN_ENCRYPTION_KEY);
      const token = await this.repository.upsertToken({
        userId: flow.requestedBy,
        githubUserId: user.id,
        githubLogin: user.login,
        accessTokenEncrypted: encryptedToken,
        scope: tokenResponse.scope ?? env.GITHUB_OAUTH_SCOPES,
        expiresAt: null,
      });
      await this.repository.markFlowAuthorized(flowId, token.id);
      return;
    }
  }
}
