import type { Pool } from "pg";
import { HttpError } from "../../common/http-error.js";
import type { CreateFolderInput, Folder, UpdateFolderInput } from "./folder.types.js";

export interface FolderRepository {
  findById(folderId: string): Promise<Folder | null>;
  create(sectionId: string, input: CreateFolderInput): Promise<Folder>;
  update(folderId: string, input: UpdateFolderInput): Promise<Folder | null>;
  delete(folderId: string): Promise<boolean>;
}

type FolderRow = {
  id: string;
  section_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
};

const toFolder = (row: FolderRow): Folder => ({
  id: row.id,
  sectionId: row.section_id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PgFolderRepository implements FolderRepository {
  constructor(private readonly pool: Pool) {}

  async findById(folderId: string): Promise<Folder | null> {
    const result = await this.pool.query<FolderRow>(
      `
      SELECT id, section_id, name, created_at, updated_at
      FROM folders
      WHERE id = $1
      LIMIT 1
      `,
      [folderId]
    );
    const row = result.rows[0];
    return row ? toFolder(row) : null;
  }

  async create(sectionId: string, input: CreateFolderInput): Promise<Folder> {
    const id = crypto.randomUUID();

    try {
      const result = await this.pool.query<FolderRow>(
        `
        INSERT INTO folders (id, section_id, name)
        VALUES ($1, $2, $3)
        RETURNING id, section_id, name, created_at, updated_at
        `,
        [id, sectionId, input.name]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Failed to create folder");
      }
      return toFolder(row);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        throw new HttpError(409, "이미 같은 이름의 폴더가 있습니다.");
      }
      if (code === "23503") {
        throw new HttpError(404, "섹션을 찾을 수 없습니다.");
      }
      throw error;
    }
  }

  async update(folderId: string, input: UpdateFolderInput): Promise<Folder | null> {
    try {
      const result = await this.pool.query<FolderRow>(
        `
        UPDATE folders
        SET name = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, section_id, name, created_at, updated_at
        `,
        [folderId, input.name]
      );
      const row = result.rows[0];
      return row ? toFolder(row) : null;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "이미 같은 이름의 폴더가 있습니다.");
      }
      throw error;
    }
  }

  async delete(folderId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM folders WHERE id = $1", [folderId]);
    return (result.rowCount ?? 0) > 0;
  }
}
