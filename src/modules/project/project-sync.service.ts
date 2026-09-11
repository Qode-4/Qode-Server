import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { HttpError } from "../../common/http-error.js";
import { env } from "../../config/env.js";
import { decryptSecret } from "../../lib/secret-crypto.js";
import type { ProjectRepository } from "./project.repository.js";
import type { ProjectSyncErrorCode, ProjectSyncJob, ProjectSyncStatusView } from "./project.types.js";

const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETRIES = 1;
const KEEP_SUCCESS_RELEASES = 2;
const DEFAULT_REPOS_ROOT = resolve(process.cwd(), env.SYNC_REPO_BASE_DIR);

class SyncJobError extends Error {
  constructor(
    public readonly code: ProjectSyncErrorCode,
    message: string,
    public readonly retriable = false
  ) {
    super(message);
    this.name = "SyncJobError";
  }
}

const runGitCommand = async (
  args: string[],
  timeoutMs = SYNC_TIMEOUT_MS,
  options?: { env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolveResult, rejectResult) => {
    const finalArgs = ["-c", "credential.helper=", ...args];
    const child = spawn("git", finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(options?.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectResult(new SyncJobError("PROJECT_SYNC_TIMEOUT", "Git command timed out", true));
        return;
      }
      if (code === 0) {
        resolveResult({ stdout, stderr });
        return;
      }
      rejectResult(new Error(`git command failed with code ${code}: ${stderr || stdout || "unknown error"}`));
    });
  });
};

const toSyncJobError = (error: unknown): SyncJobError => {
  if (error instanceof SyncJobError) {
    return error;
  }

  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();

  if (message.includes("repository not found")) {
    return new SyncJobError(
      "PROJECT_SYNC_REPO_ACCESS_DENIED_OR_NOT_FOUND",
      "Repository not found or access denied"
    );
  }
  if (
    message.includes("authentication failed") ||
    message.includes("could not read username") ||
    message.includes("access denied")
  ) {
    return new SyncJobError("PROJECT_SYNC_OAUTH_REAUTH_REQUIRED", "Repository authentication failed");
  }
  if (
    message.includes("could not resolve host") ||
    message.includes("failed to connect") ||
    message.includes("network is unreachable")
  ) {
    return new SyncJobError("PROJECT_SYNC_NETWORK_ERROR", "Repository network error", true);
  }
  if (message.includes("timed out")) {
    return new SyncJobError("PROJECT_SYNC_TIMEOUT", "Repository sync timed out", true);
  }
  if (message.includes("enospc") || message.includes("no space left on device")) {
    return new SyncJobError("PROJECT_SYNC_STORAGE_ERROR", "Not enough storage for sync");
  }

  return new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Unexpected sync error");
};

const toStatusView = (job?: ProjectSyncJob | null): ProjectSyncStatusView => {
  if (!job) {
    return "idle";
  }
  if (job.status === "queued") {
    return "queued";
  }
  if (job.status === "syncing") {
    return "syncing";
  }
  if (job.status === "done") {
    return "done";
  }
  return "failed";
};

const formatErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
};

export class ProjectSyncCoordinator {
  private readonly queue: ProjectSyncJob[] = [];
  private readonly runningProjectIds = new Set<string>();
  private readonly removedProjectIds = new Set<string>();
  private runningCount = 0;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly options: {
      reposRoot?: string;
      maxConcurrency?: number;
      onJobCompleted?: (input: {
        projectId: string;
        syncJobId: string;
        syncedCommit: string;
      }) => Promise<void> | void;
    } = {}
  ) {}

  enqueue(job: ProjectSyncJob): void {
    this.queue.push(job);
    if (!env.SYNC_WORKER_ENABLED) {
      return;
    }
    this.drain();
  }

  removeProject(projectId: string): void {
    this.removedProjectIds.add(projectId);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.projectId === projectId) {
        this.queue.splice(index, 1);
      }
    }
  }

  private drain(): void {
    const maxConcurrency = this.options.maxConcurrency ?? env.SYNC_MAX_CONCURRENCY;
    while (this.runningCount < maxConcurrency) {
      const nextIndex = this.queue.findIndex((job) => !this.runningProjectIds.has(job.projectId));
      if (nextIndex < 0) {
        return;
      }
      const [job] = this.queue.splice(nextIndex, 1);
      if (!job) {
        return;
      }
      this.runningCount += 1;
      this.runningProjectIds.add(job.projectId);
      void this.run(job).finally(() => {
        this.runningCount -= 1;
        this.runningProjectIds.delete(job.projectId);
        this.drain();
      });
    }
  }

  private async run(job: ProjectSyncJob): Promise<void> {
    if (this.removedProjectIds.has(job.projectId)) {
      return;
    }

    await this.repository.markSyncJobRunning(job.id);
    let lastError: SyncJobError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const syncedCommit = await this.syncProjectRepository(job.projectId, job.id);
        if (this.removedProjectIds.has(job.projectId)) {
          return;
        }
        await this.repository.completeSyncJob(job.id, syncedCommit);
        try {
          if (this.removedProjectIds.has(job.projectId)) {
            return;
          }
          await this.options.onJobCompleted?.({
            projectId: job.projectId,
            syncJobId: job.id,
            syncedCommit,
          });
        } catch {
          // 분석 캐시 갱신 실패가 동기화 성공을 되돌리지는 않습니다.
        }
        return;
      } catch (error) {
        const mapped = toSyncJobError(error);
        lastError = mapped;
        if (this.removedProjectIds.has(job.projectId)) {
          return;
        }
        if (!mapped.retriable || attempt === MAX_RETRIES) {
          break;
        }
      }
    }

    if (this.removedProjectIds.has(job.projectId)) {
      return;
    }
    await this.repository.failSyncJob(
      job.id,
      lastError?.code ?? "PROJECT_SYNC_UNKNOWN_ERROR",
      formatErrorMessage(lastError ?? "Unexpected sync error")
    );
  }

  private async syncProjectRepository(projectId: string, jobId: string): Promise<string> {
    if (this.removedProjectIds.has(projectId)) {
      throw new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Project has been deleted");
    }

    const target = await this.repository.getSyncTarget(projectId);
    if (!target) {
      throw new SyncJobError("PROJECT_SYNC_REPO_NOT_CONFIGURED", "Project repository is not connected");
    }

    const token = await this.repository.getOauthTokenByRefId(target.tokenRefId);
    if (!token) {
      throw new SyncJobError("PROJECT_SYNC_OAUTH_REAUTH_REQUIRED", "OAuth token not found");
    }
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
      throw new SyncJobError("PROJECT_SYNC_OAUTH_REAUTH_REQUIRED", "OAuth token expired");
    }

    const accessToken = decryptSecret(token.accessTokenEncrypted, env.TOKEN_ENCRYPTION_KEY);
    const reposRoot = this.options.reposRoot ?? DEFAULT_REPOS_ROOT;
    const projectRoot = resolve(reposRoot, projectId);
    const tmpRoot = resolve(projectRoot, "tmp");
    const releasesRoot = resolve(projectRoot, "releases");
    const stagingPath = resolve(tmpRoot, jobId);
    const releasePath = resolve(releasesRoot, jobId);
    const currentPath = resolve(projectRoot, "current");
    const nextCurrentPath = resolve(projectRoot, "current.next");
    const askpassPath = resolve(tmpRoot, `${jobId}.askpass.sh`);

    await this.repository.updateSyncJobProgress(jobId, 10);
    await mkdir(tmpRoot, { recursive: true });
    await mkdir(releasesRoot, { recursive: true });
    await rm(stagingPath, { recursive: true, force: true });
    await rm(releasePath, { recursive: true, force: true });
    await rm(askpassPath, { recursive: true, force: true });

    await writeFile(
      askpassPath,
      `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$QODE_GIT_ACCESS_TOKEN" ;;
  *) echo "" ;;
esac
`,
      { mode: 0o700 }
    );
    await chmod(askpassPath, 0o700);
    const gitEnv = {
      ...process.env,
      GIT_ASKPASS: askpassPath,
      QODE_GIT_ACCESS_TOKEN: accessToken,
    };

    try {
      if (this.removedProjectIds.has(projectId)) {
        throw new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Project has been deleted");
      }
      await this.repository.updateSyncJobProgress(jobId, 45);
      await runGitCommand(["clone", "--depth", "1", target.gitUrl, stagingPath], SYNC_TIMEOUT_MS, {
        env: gitEnv,
      });

      if (this.removedProjectIds.has(projectId)) {
        throw new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Project has been deleted");
      }
      await this.repository.updateSyncJobProgress(jobId, 65);
      await runGitCommand(["-C", stagingPath, "checkout", "--force", "HEAD"], SYNC_TIMEOUT_MS, {
        env: gitEnv,
      });

      if (this.removedProjectIds.has(projectId)) {
        throw new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Project has been deleted");
      }
      await this.repository.updateSyncJobProgress(jobId, 80);
      const commitResult = await runGitCommand(["-C", stagingPath, "rev-parse", "HEAD"], SYNC_TIMEOUT_MS, {
        env: gitEnv,
      });
      const syncedCommit = commitResult.stdout.trim();
      if (!syncedCommit) {
        throw new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Unable to resolve synced commit");
      }
      await stat(resolve(stagingPath, ".git"));

      if (this.removedProjectIds.has(projectId)) {
        throw new SyncJobError("PROJECT_SYNC_UNKNOWN_ERROR", "Project has been deleted");
      }
      await this.repository.updateSyncJobProgress(jobId, 95);
      await rename(stagingPath, releasePath);
      await rm(nextCurrentPath, { recursive: true, force: true });
      await symlink(releasePath, nextCurrentPath);
      try {
        await rename(nextCurrentPath, currentPath);
      } catch {
        await rm(currentPath, { recursive: true, force: true });
        await rename(nextCurrentPath, currentPath);
      }

      await this.cleanupOldReleases(releasesRoot, currentPath);
      return syncedCommit;
    } finally {
      await rm(askpassPath, { recursive: true, force: true });
    }
  }

  private async cleanupOldReleases(releasesRoot: string, currentPath: string): Promise<void> {
    const entries = await readdir(releasesRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(releasesRoot, entry.name));
    if (dirs.length <= KEEP_SUCCESS_RELEASES) {
      return;
    }

    let currentTargetPath: string | null = null;
    try {
      const currentTarget = await readlink(currentPath);
      currentTargetPath = isAbsolute(currentTarget)
        ? currentTarget
        : resolve(dirname(currentPath), currentTarget);
    } catch {
      currentTargetPath = null;
    }

    const withStats = await Promise.all(
      dirs.map(async (dir) => {
        const itemStat = await stat(dir);
        return { dir, mtimeMs: itemStat.mtimeMs };
      })
    );
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const kept = new Set(withStats.slice(0, KEEP_SUCCESS_RELEASES).map((item) => item.dir));
    if (currentTargetPath) {
      kept.add(currentTargetPath);
    }

    for (const item of withStats) {
      if (!kept.has(item.dir)) {
        await rm(item.dir, { recursive: true, force: true });
      }
    }
  }
}

export class ProjectSyncService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly coordinator: ProjectSyncCoordinator
  ) {}

  async requestSync(projectId: string, currentUserId: string): Promise<ProjectSyncJob> {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.", {
        code: "PROJECT_SYNC_PROJECT_NOT_FOUND",
      });
    }

    const role = await this.repository.findMemberRole(projectId, currentUserId);
    if (role !== "OWNER") {
      throw new HttpError(403, "코드 동기화를 실행할 권한이 없습니다.", {
        code: "PROJECT_SYNC_FORBIDDEN",
      });
    }

    const target = await this.repository.getSyncTarget(projectId);
    if (!target) {
      throw new HttpError(400, "Git 연결이 설정되어 있지 않습니다.", {
        code: "PROJECT_SYNC_REPO_NOT_CONFIGURED",
      });
    }

    const token = await this.repository.getOauthTokenByRefId(target.tokenRefId);
    if (!token || (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())) {
      throw new HttpError(424, "GitHub 인증이 만료되었습니다. 다시 인증해 주세요.", {
        code: "PROJECT_SYNC_OAUTH_REAUTH_REQUIRED",
      });
    }

    const running = await this.repository.findRunningSyncJobByProject(projectId);
    if (running) {
      throw new HttpError(409, "이미 진행 중인 동기화 작업이 있습니다.", {
        code: "PROJECT_SYNC_ALREADY_RUNNING",
        jobId: running.id,
      });
    }

    const job = await this.repository.createSyncJob({ projectId, requestedBy: currentUserId });
    this.coordinator.enqueue(job);
    return job;
  }

  async getSyncJobOrThrow(projectId: string, jobId: string, currentUserId: string): Promise<ProjectSyncJob> {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.", {
        code: "PROJECT_SYNC_PROJECT_NOT_FOUND",
      });
    }

    const role = await this.repository.findMemberRole(projectId, currentUserId);
    if (role !== "OWNER") {
      throw new HttpError(403, "동기화 상태를 조회할 권한이 없습니다.", {
        code: "PROJECT_SYNC_FORBIDDEN",
      });
    }

    const job = await this.repository.findSyncJobById(projectId, jobId);
    if (!job) {
      throw new HttpError(404, "동기화 작업을 찾을 수 없습니다.", {
        code: "PROJECT_SYNC_JOB_NOT_FOUND",
      });
    }
    return job;
  }

  async getLatestSyncStatusOrThrow(projectId: string, currentUserId: string): Promise<{
    status: ProjectSyncStatusView;
    latestJob: ProjectSyncJob | null;
  }> {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.", {
        code: "PROJECT_SYNC_PROJECT_NOT_FOUND",
      });
    }

    const role = await this.repository.findMemberRole(projectId, currentUserId);
    if (!role) {
      throw new HttpError(403, "동기화 상태를 조회할 권한이 없습니다.", {
        code: "PROJECT_SYNC_FORBIDDEN",
      });
    }

    const latest = await this.repository.getLatestSyncJob(projectId);
    return {
      status: toStatusView(latest),
      latestJob: latest ?? null,
    };
  }
}
