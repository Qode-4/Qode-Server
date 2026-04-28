import type { Pool } from "pg";
import { HttpError } from "../../common/http-error.js";
import type { SectionFolderMemoryState } from "../section/section.repository.js";
import { createSectionFolderMemoryState } from "../section/section.repository.js";
import type { CreateFolderInput, Folder, UpdateFolderInput } from "./folder.types.js";

export interface FolderRepository {
  findById(folderId: string): Promise<Folder | null>;
  create(sectionId: string, input: CreateFolderInput): Promise<Folder>;
  update(folderId: string, input: UpdateFolderInput): Promise<Folder | null>;
  delete(folderId: string): Promise<boolean>;
}

export class InMemoryFolderRepository implements FolderRepository {
  constructor(
    private readonly state: SectionFolderMemoryState = createSectionFolderMemoryState()
  ) {}

  async findById(folderId: string): Promise<Folder | null> {
    return this.state.folders.get(folderId) ?? null;
  }

  async create(sectionId: string, input: CreateFolderInput): Promise<Folder> {
    const section = this.state.sections.get(sectionId);
    if (!section) {
      throw new HttpError(404, "섹션을 찾을 수 없습니다.");
    }

    const duplicate = Array.from(this.state.folders.values()).find(
      (folder) => folder.sectionId === sectionId && folder.name === input.name
    );
    if (duplicate) {
      throw new HttpError(409, "이미 같은 이름의 폴더가 있습니다.");
    }

    const now = new Date().toISOString();
    const folder: Folder = {
      id: crypto.randomUUID(),
      sectionId,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    };
    this.state.folders.set(folder.id, folder);
    return folder;
  }

  async update(folderId: string, input: UpdateFolderInput): Promise<Folder | null> {
    const current = this.state.folders.get(folderId);
    if (!current) {
      return null;
    }

    const duplicate = Array.from(this.state.folders.values()).find(
      (folder) =>
        folder.id !== folderId &&
        folder.sectionId === current.sectionId &&
        folder.name === input.name
    );
    if (duplicate) {
      throw new HttpError(409, "이미 같은 이름의 폴더가 있습니다.");
    }

    const next: Folder = {
      ...current,
      name: input.name,
      updatedAt: new Date().toISOString(),
    };
    this.state.folders.set(folderId, next);
    return next;
  }

  async delete(folderId: string): Promise<boolean> {
    return this.state.folders.delete(folderId);
  }
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
