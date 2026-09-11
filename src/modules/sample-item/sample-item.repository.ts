import type { Pool } from "pg";
import type {
  CreateSampleItemInput,
  SampleItem,
  UpdateSampleItemInput,
} from "./sample-item.types.js";

// 서비스/라우트 계층이 저장소 구현에 의존하지 않도록 하는 추상화입니다.
export interface SampleItemRepository {
  list(): Promise<SampleItem[]>;
  findById(id: string): Promise<SampleItem | null>;
  create(input: CreateSampleItemInput): Promise<SampleItem>;
  update(id: string, input: UpdateSampleItemInput): Promise<SampleItem | null>;
  delete(id: string): Promise<boolean>;
}

type SampleItemRow = {
  id: string;
  title: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
};

// DB의 snake_case 컬럼을 API의 camelCase 필드로 변환합니다.
const toSampleItem = (row: SampleItemRow): SampleItem => ({
  id: row.id,
  title: row.title,
  description: row.description ?? undefined,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PgSampleItemRepository implements SampleItemRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<SampleItem[]> {
    const result = await this.pool.query<SampleItemRow>(
      `
      SELECT id, title, description, created_at, updated_at
      FROM sample_items
      ORDER BY created_at DESC
      `
    );

    return result.rows.map(toSampleItem);
  }

  async findById(id: string): Promise<SampleItem | null> {
    const result = await this.pool.query<SampleItemRow>(
      `
      SELECT id, title, description, created_at, updated_at
      FROM sample_items
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return toSampleItem(row);
  }

  async create(input: CreateSampleItemInput): Promise<SampleItem> {
    const id = crypto.randomUUID();
    const result = await this.pool.query<SampleItemRow>(
      `
      INSERT INTO sample_items (id, title, description)
      VALUES ($1, $2, $3)
      RETURNING id, title, description, created_at, updated_at
      `,
      [id, input.title, input.description ?? null]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create sample item");
    }

    return toSampleItem(row);
  }

  async update(id: string, input: UpdateSampleItemInput): Promise<SampleItem | null> {
    // PATCH에서 생략된 필드는 기존 값을 유지합니다.
    const result = await this.pool.query<SampleItemRow>(
      `
      UPDATE sample_items
      SET
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, title, description, created_at, updated_at
      `,
      [id, input.title ?? null, input.description ?? null]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return toSampleItem(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM sample_items WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
