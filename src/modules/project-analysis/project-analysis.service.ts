import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError } from "../../common/http-error.js";
import { env } from "../../config/env.js";
import { OpenAiClient } from "../../lib/openai-client.js";
import type { ProjectRepository } from "../project/project.repository.js";
import type { ProjectAnalysisRepository } from "./project-analysis.repository.js";
import type { ProjectAnalysis } from "./project-analysis.types.js";

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_FILE_BYTES = 12_000;
const DEFAULT_MAX_CONTEXT_CHARS = 180_000;

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);
const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".sql",
  ".yml",
  ".yaml",
  ".sh",
  ".txt",
]);

const SENSITIVE_FILE_PATTERNS = [/\.env/i, /id_rsa/i, /private.?key/i, /pem$/i];

const extensionOf = (path: string): string => {
  const index = path.lastIndexOf(".");
  if (index < 0) {
    return "";
  }
  return path.slice(index).toLowerCase();
};

const isSensitivePath = (path: string): boolean => {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(path));
};

export class ProjectAnalysisService {
  private readonly runningProjects = new Set<string>();
  private readonly reposRoot = resolve(process.cwd(), env.SYNC_REPO_BASE_DIR);

  constructor(
    private readonly repository: ProjectAnalysisRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly openAiClient: OpenAiClient
  ) {}

  async getOrThrow(projectId: string, currentUserId: string): Promise<ProjectAnalysis> {
    const exists = await this.projectRepository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.", {
        code: "PROJECT_SYNC_PROJECT_NOT_FOUND",
      });
    }

    const role = await this.projectRepository.findMemberRole(projectId, currentUserId);
    if (!role) {
      throw new HttpError(403, "프로젝트 분석을 조회할 권한이 없습니다.", {
        code: "PROJECT_SYNC_FORBIDDEN",
      });
    }

    const analysis = await this.repository.findByProjectId(projectId);
    if (!analysis) {
      throw new HttpError(404, "프로젝트 분석 결과가 없습니다.", {
        code: "PROJECT_ANALYSIS_NOT_FOUND",
      });
    }

    return analysis;
  }

  async requestRebuild(projectId: string, currentUserId: string): Promise<void> {
    const exists = await this.projectRepository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.", {
        code: "PROJECT_SYNC_PROJECT_NOT_FOUND",
      });
    }

    const role = await this.projectRepository.findMemberRole(projectId, currentUserId);
    if (role !== "OWNER") {
      throw new HttpError(403, "프로젝트 분석을 실행할 권한이 없습니다.", {
        code: "PROJECT_SYNC_FORBIDDEN",
      });
    }

    const latestSyncJob = await this.projectRepository.getLatestSyncJob(projectId);
    const sourceCommit = latestSyncJob?.syncedCommit ?? null;
    await this.scheduleRebuild(projectId, sourceCommit);
  }

  markProjectDeleted(projectId: string): void {
    this.runningProjects.delete(projectId);
  }

  private isProjectReferenceError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const pgError = error as { code?: string };
    return pgError.code === "23503";
  }

  private async upsertIfProjectExists(input: {
    projectId: string;
    status: "building" | "ready" | "failed";
    summary: ProjectAnalysis["summary"];
    sourceCommit: string | null;
    errorMessage: string | null;
  }): Promise<boolean> {
    const exists = await this.projectRepository.existsById(input.projectId);
    if (!exists) {
      return false;
    }

    try {
      await this.repository.upsertAnalysis(input);
      return true;
    } catch (error) {
      if (this.isProjectReferenceError(error)) {
        return false;
      }
      throw error;
    }
  }

  async scheduleRebuild(projectId: string, sourceCommit: string | null): Promise<void> {
    const queued = await this.upsertIfProjectExists({
      projectId,
      status: "building",
      summary: null,
      sourceCommit,
      errorMessage: null,
    });
    if (!queued) {
      return;
    }

    if (this.runningProjects.has(projectId)) {
      return;
    }

    this.runningProjects.add(projectId);
    void this.rebuild(projectId, sourceCommit).finally(() => {
      this.runningProjects.delete(projectId);
    });
  }

  private async rebuild(projectId: string, sourceCommit: string | null): Promise<void> {
    try {
      const repositorySnapshot = await this.collectRepositorySnapshot(projectId);
      const summary = await this.openAiClient.generateProjectAnalysis({
        projectId,
        sourceCommit,
        repositorySnapshot,
      });

      await this.upsertIfProjectExists({
        projectId,
        status: "ready",
        summary,
        sourceCommit,
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      try {
        await this.upsertIfProjectExists({
          projectId,
          status: "failed",
          summary: null,
          sourceCommit,
          errorMessage: message,
        });
      } catch {
        // 프로젝트 삭제/경합 중 분석 실패 기록 저장이 실패해도 워커를 중단시키지 않습니다.
      }
    }
  }

  private async collectRepositorySnapshot(projectId: string): Promise<string> {
    const currentPath = resolve(this.reposRoot, projectId, "current");
    const maxFiles = DEFAULT_MAX_FILES;
    const maxFileBytes = DEFAULT_MAX_FILE_BYTES;
    const maxContextChars = DEFAULT_MAX_CONTEXT_CHARS;

    const files: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= maxFiles) {
          return;
        }

        const fullPath = resolve(directory, entry.name);
        const relativePath = fullPath.slice(currentPath.length + 1);
        if (!relativePath) {
          continue;
        }

        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) {
            continue;
          }
          await walk(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        if (isSensitivePath(relativePath)) {
          continue;
        }

        const ext = extensionOf(relativePath);
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          continue;
        }

        const fileStat = await stat(fullPath);
        if (fileStat.size <= 0) {
          continue;
        }

        files.push(relativePath);
      }
    };

    await walk(currentPath);

    if (files.length === 0) {
      return "No readable files found from synced project repository.";
    }

    let snapshot = "";
    for (const filePath of files.sort()) {
      if (snapshot.length >= maxContextChars) {
        break;
      }

      const fullPath = resolve(currentPath, filePath);
      const raw = await readFile(fullPath, "utf8");
      const trimmed = raw.slice(0, maxFileBytes);
      snapshot += [`\n## FILE: ${filePath}\n`, trimmed].join("");
    }

    return snapshot.slice(0, maxContextChars);
  }
}
