import type { Pool } from "pg";
import { HttpError } from "../../common/http-error.js";
import type {
  CreateSectionInput,
  Section,
  SectionTreeItem,
  UpdateSectionInput,
} from "./section.types.js";

export interface SectionRepository {
  listTreeByProject(projectId: string): Promise<SectionTreeItem[]>;
  findById(sectionId: string): Promise<Section | null>;
  create(projectId: string, input: CreateSectionInput): Promise<Section>;
  update(sectionId: string, input: UpdateSectionInput): Promise<Section | null>;
  delete(sectionId: string): Promise<boolean>;
}

type SectionRow = {
  id: string;
  project_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
};

type SectionTreeRow = SectionRow & {
  folder_id: string | null;
  folder_name: string | null;
  folder_created_at: Date | null;
  folder_updated_at: Date | null;
};

const toSection = (row: SectionRow): Section => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PgSectionRepository implements SectionRepository {
  constructor(private readonly pool: Pool) {}

  async listTreeByProject(projectId: string): Promise<SectionTreeItem[]> {
    const result = await this.pool.query<SectionTreeRow>(
      `
      SELECT
        s.id,
        s.project_id,
        s.name,
        s.created_at,
        s.updated_at,
        f.id AS folder_id,
        f.name AS folder_name,
        f.created_at AS folder_created_at,
        f.updated_at AS folder_updated_at
      FROM sections s
      LEFT JOIN folders f
        ON f.section_id = s.id
      WHERE s.project_id = $1
      ORDER BY s.created_at DESC, f.created_at DESC NULLS LAST
      `,
      [projectId]
    );

    const sections = new Map<string, SectionTreeItem>();
    for (const row of result.rows) {
      const existing = sections.get(row.id);
      if (!existing) {
        sections.set(row.id, {
          id: row.id,
          projectId: row.project_id,
          name: row.name,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          folders: [],
        });
      }

      if (row.folder_id) {
        sections.get(row.id)?.folders.push({
          id: row.folder_id,
          sectionId: row.id,
          name: row.folder_name ?? "",
          createdAt: row.folder_created_at?.toISOString() ?? new Date(0).toISOString(),
          updatedAt: row.folder_updated_at?.toISOString() ?? new Date(0).toISOString(),
        });
      }
    }

    return Array.from(sections.values())
      .map((section) => ({
        ...section,
        folders: section.folders.sort((a, b) => a.name.localeCompare(b.name, "ko")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }

  async findById(sectionId: string): Promise<Section | null> {
    const result = await this.pool.query<SectionRow>(
      `
      SELECT id, project_id, name, created_at, updated_at
      FROM sections
      WHERE id = $1
      LIMIT 1
      `,
      [sectionId]
    );
    const row = result.rows[0];
    return row ? toSection(row) : null;
  }

  async create(projectId: string, input: CreateSectionInput): Promise<Section> {
    const id = crypto.randomUUID();

    try {
      const result = await this.pool.query<SectionRow>(
        `
        INSERT INTO sections (id, project_id, name)
        VALUES ($1, $2, $3)
        RETURNING id, project_id, name, created_at, updated_at
        `,
        [id, projectId, input.name]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Failed to create section");
      }
      return toSection(row);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "이미 같은 이름의 섹션이 있습니다.");
      }
      throw error;
    }
  }

  async update(sectionId: string, input: UpdateSectionInput): Promise<Section | null> {
    try {
      const result = await this.pool.query<SectionRow>(
        `
        UPDATE sections
        SET name = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, project_id, name, created_at, updated_at
        `,
        [sectionId, input.name]
      );
      const row = result.rows[0];
      return row ? toSection(row) : null;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "이미 같은 이름의 섹션이 있습니다.");
      }
      throw error;
    }
  }

  async delete(sectionId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM sections WHERE id = $1", [sectionId]);
    return (result.rowCount ?? 0) > 0;
  }
}
