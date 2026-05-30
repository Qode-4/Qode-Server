import type { Pool } from "pg";
import { HttpError } from "../../common/http-error.js";
import type {
  CreateStorageItemInput,
  StorageItem,
  StorageItemMetadata,
  StorageItemType,
  UpdateStorageItemInput,
} from "./storage-item.types.js";

export interface StorageItemRepository {
  listByProject(projectId: string): Promise<StorageItem[]>;
  findById(projectId: string, id: string): Promise<StorageItem | null>;
  create(
    projectId: string,
    input: CreateStorageItemInput,
    creator: { id: string; name: string; avatarUrl: string | null }
  ): Promise<StorageItem>;
  update(
    projectId: string,
    id: string,
    input: UpdateStorageItemInput
  ): Promise<StorageItem | null>;
  delete(projectId: string, id: string): Promise<boolean>;
}

type StorageItemRow = {
  id: string;
  project_id: string;
  type: StorageItemType;
  title: string;
  url: string;
  metadata: StorageItemMetadata;
  created_by: string;
  created_by_name: string;
  created_by_avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
};

const toStorageItem = (row: StorageItemRow): StorageItem => ({
  id: row.id,
  projectId: row.project_id,
  type: row.type,
  title: row.title,
  url: row.url,
  metadata: row.metadata,
  createdBy: {
    id: row.created_by,
    name: row.created_by_name,
    avatarUrl: row.created_by_avatar_url,
  },
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const SELECT_WITH_USER = `
  SELECT
    si.id,
    si.project_id,
    si.type,
    si.title,
    si.url,
    si.metadata,
    si.created_by,
    u.name AS created_by_name,
    u.avatar_url AS created_by_avatar_url,
    si.created_at,
    si.updated_at
  FROM storage_items si
  INNER JOIN users u ON u.id = si.created_by
`;

export class PgStorageItemRepository implements StorageItemRepository {
  constructor(private readonly pool: Pool) {}

  async listByProject(projectId: string): Promise<StorageItem[]> {
    const result = await this.pool.query<StorageItemRow>(
      `${SELECT_WITH_USER}
      WHERE si.project_id = $1
      ORDER BY si.created_at DESC`,
      [projectId]
    );
    return result.rows.map(toStorageItem);
  }

  async findById(projectId: string, id: string): Promise<StorageItem | null> {
    const result = await this.pool.query<StorageItemRow>(
      `${SELECT_WITH_USER}
      WHERE si.project_id = $1 AND si.id = $2
      LIMIT 1`,
      [projectId, id]
    );
    const row = result.rows[0];
    return row ? toStorageItem(row) : null;
  }

  async create(
    projectId: string,
    input: CreateStorageItemInput,
    creator: { id: string; name: string; avatarUrl: string | null }
  ): Promise<StorageItem> {
    const id = crypto.randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO storage_items
           (id, project_id, type, title, url, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          id,
          projectId,
          input.type,
          input.title,
          input.url,
          JSON.stringify(input.metadata),
          creator.id,
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "이미 등록된 URL입니다.");
      }
      throw error;
    }

    const created = await this.findById(projectId, id);
    if (!created) {
      throw new Error("Failed to reload created storage item");
    }
    return created;
  }

  async update(
    projectId: string,
    id: string,
    input: UpdateStorageItemInput
  ): Promise<StorageItem | null> {
    const result = await this.pool.query(
      `UPDATE storage_items
       SET title = $3, updated_at = NOW()
       WHERE project_id = $1 AND id = $2`,
      [projectId, id, input.title]
    );
    if ((result.rowCount ?? 0) === 0) {
      return null;
    }
    return this.findById(projectId, id);
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM storage_items WHERE project_id = $1 AND id = $2`,
      [projectId, id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
