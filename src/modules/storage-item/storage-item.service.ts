import { HttpError } from "../../common/http-error.js";
import type { ProjectRepository } from "../project/project.repository.js";
import type { StorageItemRepository } from "./storage-item.repository.js";
import type {
  CreateStorageItemInput,
  StorageItemCreator,
  UpdateStorageItemInput,
} from "./storage-item.types.js";

export class StorageItemService {
  constructor(
    private readonly repository: StorageItemRepository,
    private readonly projectRepository: ProjectRepository
  ) {}

  async list(projectId: string, currentUserId: string) {
    await this.assertProjectMember(projectId, currentUserId);
    return this.repository.listByProject(projectId);
  }

  async getByIdOrThrow(projectId: string, id: string, currentUserId: string) {
    await this.assertProjectMember(projectId, currentUserId);
    const item = await this.repository.findById(projectId, id);
    if (!item) {
      throw new HttpError(404, "저장소 아이템을 찾을 수 없습니다.");
    }
    return item;
  }

  async create(
    projectId: string,
    input: CreateStorageItemInput,
    creator: StorageItemCreator
  ) {
    await this.assertProjectMember(projectId, creator.id);
    return this.repository.create(projectId, input, creator);
  }

  async updateOrThrow(
    projectId: string,
    id: string,
    input: UpdateStorageItemInput,
    currentUserId: string
  ) {
    await this.assertProjectMember(projectId, currentUserId);
    const updated = await this.repository.update(projectId, id, input);
    if (!updated) {
      throw new HttpError(404, "저장소 아이템을 찾을 수 없습니다.");
    }
    return updated;
  }

  async deleteOrThrow(projectId: string, id: string, currentUserId: string) {
    await this.assertProjectMember(projectId, currentUserId);
    const deleted = await this.repository.delete(projectId, id);
    if (!deleted) {
      throw new HttpError(404, "저장소 아이템을 찾을 수 없습니다.");
    }
  }

  private async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const exists = await this.projectRepository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }
    const role = await this.projectRepository.findMemberRole(projectId, userId);
    if (!role) {
      throw new HttpError(403, "저장소 접근 권한이 없습니다.");
    }
  }
}
