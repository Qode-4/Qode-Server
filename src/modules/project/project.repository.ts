import type { Pool } from "pg";
import type { CreateProjectInput, Project } from "./project.types.js";

export interface ProjectRepository {
  list(): Promise<Project[]>;
  create(input: CreateProjectInput): Promise<Project>;
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, Project>();

  async list(): Promise<Project[]> {
    return Array.from(this.store.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1
    );
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const inviteCode = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const item: Project = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description ?? null,
      gitUrl: input.gitUrl ?? null,
      inviteCode,
      lastSyncedAt: null,
      questionCount: 0,
      createdAt: now,
      createdBy: {
        id: input.createdBy.id,
        name: input.createdBy.name,
        avatarUrl: input.createdBy.avatarUrl ?? null,
      },
      role: "OWNER",
    };

    this.store.set(item.id, item);
    return item;
  }
}

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  git_url: string | null;
  invite_code: string;
  last_synced_at: Date | null;
  question_count: number;
  created_at: Date;
  created_by_id: string;
  created_by_name: string;
  created_by_avatar_url: string | null;
  role: "OWNER";
};

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  description: row.description ?? null,
  gitUrl: row.git_url ?? null,
  inviteCode: row.invite_code,
  lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
  questionCount: row.question_count,
  createdAt: row.created_at.toISOString(),
  createdBy: {
    id: row.created_by_id,
    name: row.created_by_name,
    avatarUrl: row.created_by_avatar_url ?? null,
  },
  role: row.role,
});

export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Project[]> {
    const result = await this.pool.query<ProjectRow>(
      `
      SELECT
        id,
        name,
        description,
        git_url,
        invite_code,
        last_synced_at,
        question_count,
        created_at,
        created_by_id,
        created_by_name,
        created_by_avatar_url,
        role
      FROM projects
      ORDER BY created_at DESC
      `
    );

    return result.rows.map(toProject);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const id = crypto.randomUUID();
    const inviteCode = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const result = await this.pool.query<ProjectRow>(
      `
      INSERT INTO projects (
        id,
        name,
        description,
        git_url,
        invite_code,
        last_synced_at,
        question_count,
        created_by_id,
        created_by_name,
        created_by_avatar_url,
        role
      )
      VALUES ($1, $2, $3, $4, $5, NULL, 0, $6, $7, $8, 'OWNER')
      RETURNING
        id,
        name,
        description,
        git_url,
        invite_code,
        last_synced_at,
        question_count,
        created_at,
        created_by_id,
        created_by_name,
        created_by_avatar_url,
        role
      `,
      [
        id,
        input.name,
        input.description ?? null,
        input.gitUrl ?? null,
        inviteCode,
        input.createdBy.id,
        input.createdBy.name,
        input.createdBy.avatarUrl ?? null,
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create project");
    }

    return toProject(row);
  }
}
