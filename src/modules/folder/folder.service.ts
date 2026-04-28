import { HttpError } from "../../common/http-error.js";
import type { ProjectRepository } from "../project/project.repository.js";
import type { SectionRepository } from "../section/section.repository.js";
import type { CreateFolderInput, UpdateFolderInput } from "./folder.types.js";
import type { FolderRepository } from "./folder.repository.js";

export class FolderService {
  constructor(
    private readonly repository: FolderRepository,
    private readonly sectionRepository: SectionRepository,
    private readonly projectRepository: ProjectRepository
  ) {}

  async create(sectionId: string, input: CreateFolderInput, currentUserId: string) {
    const section = await this.sectionRepository.findById(sectionId);
    if (!section) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    await this.assertProjectMember(section.projectId, currentUserId);
    return this.repository.create(sectionId, input);
  }

  async updateOrThrow(folderId: string, input: UpdateFolderInput, currentUserId: string) {
    const folder = await this.repository.findById(folderId);
    if (!folder) {
      throw new HttpError(404, "폴더를 찾을 수 없습니다.");
    }

    const section = await this.sectionRepository.findById(folder.sectionId);
    if (!section) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    await this.assertProjectMember(section.projectId, currentUserId);

    const updated = await this.repository.update(folderId, input);
    if (!updated) {
      throw new HttpError(404, "폴더를 찾을 수 없습니다.");
    }

    return updated;
  }

  async deleteOrThrow(folderId: string, currentUserId: string): Promise<void> {
    const folder = await this.repository.findById(folderId);
    if (!folder) {
      throw new HttpError(404, "폴더를 찾을 수 없습니다.");
    }

    const section = await this.sectionRepository.findById(folder.sectionId);
    if (!section) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    await this.assertProjectMember(section.projectId, currentUserId);

    const deleted = await this.repository.delete(folderId);
    if (!deleted) {
      throw new HttpError(404, "폴더를 찾을 수 없습니다.");
    }
  }

  private async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const exists = await this.projectRepository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const role = await this.projectRepository.findMemberRole(projectId, userId);
    if (!role) {
      throw new HttpError(403, "폴더 접근 권한이 없습니다.");
    }
  }
}
