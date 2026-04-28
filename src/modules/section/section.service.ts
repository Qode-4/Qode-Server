import { HttpError } from "../../common/http-error.js";
import type { ProjectRepository } from "../project/project.repository.js";
import type { SectionRepository } from "./section.repository.js";
import type { CreateSectionInput, UpdateSectionInput } from "./section.types.js";

export class SectionService {
  constructor(
    private readonly repository: SectionRepository,
    private readonly projectRepository: ProjectRepository
  ) {}

  async listTree(projectId: string, currentUserId: string) {
    await this.assertProjectMember(projectId, currentUserId);
    return this.repository.listTreeByProject(projectId);
  }

  async create(projectId: string, input: CreateSectionInput, currentUserId: string) {
    await this.assertProjectMember(projectId, currentUserId);
    return this.repository.create(projectId, input);
  }

  async updateOrThrow(sectionId: string, input: UpdateSectionInput, currentUserId: string) {
    const section = await this.repository.findById(sectionId);
    if (!section) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    await this.assertProjectMember(section.projectId, currentUserId);

    const updated = await this.repository.update(sectionId, input);
    if (!updated) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    return updated;
  }

  async deleteOrThrow(sectionId: string, currentUserId: string): Promise<void> {
    const section = await this.repository.findById(sectionId);
    if (!section) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    await this.assertProjectMember(section.projectId, currentUserId);

    const deleted = await this.repository.delete(sectionId);
    if (!deleted) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }
  }

  private async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const exists = await this.projectRepository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const role = await this.projectRepository.findMemberRole(projectId, userId);
    if (!role) {
      throw new HttpError(403, "섹션 접근 권한이 없습니다.");
    }
  }
}
