import { HttpError } from "../../common/http-error.js";
import type { ProjectRepository } from "./project.repository.js";
import type { CreateProjectInput } from "./project.types.js";

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  list(currentUserId: string) {
    return this.repository.list(currentUserId);
  }

  async getByIdOrThrow(projectId: string, currentUserId: string) {
    const project = await this.repository.findByIdForUser(projectId, currentUserId);
    if (!project) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    return project;
  }

  async listMembersOrThrow(projectId: string, currentUserId: string) {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const myRole = await this.repository.findMemberRole(projectId, currentUserId);
    if (!myRole) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    return this.repository.listMembers(projectId);
  }

  create(
    input: CreateProjectInput,
    creator: { id: string; name: string; avatarUrl: string | null }
  ) {
    return this.repository.create(input, creator);
  }

  async updateGitUrl(projectId: string, currentUserId: string, rawGitUrl: string) {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const role = await this.repository.findMemberRole(projectId, currentUserId);
    if (role !== "OWNER") {
      throw new HttpError(403, "Git 주소를 수정할 권한이 없습니다.");
    }

    const normalizedGitUrl = this.normalizeGithubGitUrl(rawGitUrl);
    await this.repository.updateGitUrl(projectId, normalizedGitUrl);

    return {
      id: projectId,
      gitUrl: normalizedGitUrl,
      message: "Git 주소가 성공적으로 연동되었습니다.",
    };
  }

  private normalizeGithubGitUrl(rawGitUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(rawGitUrl.trim());
    } catch {
      throw new HttpError(400, "유효하지 않은 Git URL입니다.");
    }

    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
      throw new HttpError(400, "유효하지 않은 Git URL입니다.");
    }

    if (parsed.search || parsed.hash) {
      throw new HttpError(400, "유효하지 않은 Git URL입니다.");
    }

    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 2) {
      throw new HttpError(400, "유효하지 않은 Git URL입니다.");
    }

    const [owner, repoSegment] = segments;
    if (!owner || !repoSegment) {
      throw new HttpError(400, "유효하지 않은 Git URL입니다.");
    }

    const repoName = repoSegment.replace(/\.git$/i, "");
    if (!repoName || repoName.includes("/")) {
      throw new HttpError(400, "유효하지 않은 Git URL입니다.");
    }

    return `https://github.com/${owner}/${repoName}.git`;
  }
}
