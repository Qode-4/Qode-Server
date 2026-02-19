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
}
