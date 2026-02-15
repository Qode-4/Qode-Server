import { HttpError } from "../../common/http-error.js";
import type { SampleItemRepository } from "./sample-item.repository.js";
import type { CreateSampleItemInput, UpdateSampleItemInput } from "./sample-item.types.js";

export class SampleItemService {
  constructor(private readonly repository: SampleItemRepository) {}

  // 서비스 계층에서 저장소 호출을 위임하고 도메인 에러를 일관되게 처리합니다.
  list() {
    return this.repository.list();
  }

  async getByIdOrThrow(id: string) {
    const item = await this.repository.findById(id);
    if (!item) {
      throw new HttpError(404, "Sample item not found");
    }
    return item;
  }

  create(input: CreateSampleItemInput) {
    return this.repository.create(input);
  }

  async updateOrThrow(id: string, input: UpdateSampleItemInput) {
    const item = await this.repository.update(id, input);
    if (!item) {
      throw new HttpError(404, "Sample item not found");
    }
    return item;
  }

  async deleteOrThrow(id: string) {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      throw new HttpError(404, "Sample item not found");
    }
  }
}
