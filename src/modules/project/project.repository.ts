import type { Pool, PoolClient } from "pg";
import type { CreateProjectInput, Project, ProjectMember } from "./project.types.js";

type ProjectRole = "OWNER" | "MEMBER";

type ProjectCreator = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export interface ProjectRepository {
  list(currentUserId: string): Promise<Project[]>;
  findByIdForUser(projectId: string, currentUserId: string): Promise<Project | null>;
  listMembers(projectId: string): Promise<ProjectMember[]>;
  create(input: CreateProjectInput, creator: ProjectCreator): Promise<Project>;
  existsById(projectId: string): Promise<boolean>;
  findMemberRole(projectId: string, userId: string): Promise<ProjectRole | null>;
  updateGitUrl(projectId: string, gitUrl: string): Promise<void>;
}

type StoredProject = Omit<Project, "role">;

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, StoredProject>();
  private readonly projectMembers = new Map<
    string,
    Array<{
      id: string;
      userId: string;
      role: ProjectRole;
      joinedAt: string;
      name: string;
      avatarUrl: string | null;
    }>
  >();

  async list(currentUserId: string): Promise<Project[]> {
    const projects: Project[] = [];

    for (const project of this.store.values()) {
      const members = this.projectMembers.get(project.id) ?? [];
      const me = members.find((member) => member.userId === currentUserId);
      if (!me) {
        continue;
      }

      projects.push({
        ...project,
        role: me.role,
      });
    }

    return projects.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async create(input: CreateProjectInput, creator: ProjectCreator): Promise<Project> {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const inviteCode = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const item: StoredProject = {
      id: projectId,
      name: input.name,
      description: input.description ?? null,
      gitUrl: input.gitUrl ?? null,
      inviteCode,
      lastSyncedAt: null,
      questionCount: 0,
      createdAt: now,
      createdBy: creator,
    };

    this.store.set(item.id, item);
    this.projectMembers.set(projectId, [
      {
        id: crypto.randomUUID(),
        userId: creator.id,
        role: "OWNER",
        joinedAt: now,
        name: creator.name,
        avatarUrl: creator.avatarUrl,
      },
    ]);

    return {
      ...item,
      role: "OWNER",
    };
  }

  async findByIdForUser(projectId: string, currentUserId: string): Promise<Project | null> {
    const project = this.store.get(projectId);
    if (!project) {
      return null;
    }

    const members = this.projectMembers.get(projectId) ?? [];
    const me = members.find((member) => member.userId === currentUserId);
    if (!me) {
      return null;
    }

    return {
      ...project,
      role: me.role,
    };
  }

  async existsById(projectId: string): Promise<boolean> {
    return this.store.has(projectId);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const members = this.projectMembers.get(projectId) ?? [];
    return members
      .map((member) => ({
        id: member.userId,
        name: member.name,
        avatarUrl: member.avatarUrl,
        role: member.role,
        joinedAt: member.joinedAt,
      }))
      .sort((a, b) => {
        if (a.role !== b.role) {
          return a.role === "OWNER" ? -1 : 1;
        }
        if (a.joinedAt === null || b.joinedAt === null) {
          return 0;
        }
        return a.joinedAt < b.joinedAt ? -1 : 1;
      });
  }

  async findMemberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
    const members = this.projectMembers.get(projectId) ?? [];
    const member = members.find((item) => item.userId === userId);
    return member?.role ?? null;
  }

  async updateGitUrl(projectId: string, gitUrl: string): Promise<void> {
    const current = this.store.get(projectId);
    if (!current) {
      return;
    }

    this.store.set(projectId, {
      ...current,
      gitUrl,
    });
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
  created_by_name: string | null;
  created_by_avatar_url: string | null;
  role: ProjectRole;
};

type ProjectMemberRow = {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  role: ProjectRole;
  joined_at: Date | null;
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
    name: row.created_by_name ?? "Unknown",
    avatarUrl: row.created_by_avatar_url ?? null,
  },
  role: row.role,
});

export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  private async findByIdForUserInternal(
    db: Pool | PoolClient,
    projectId: string,
    currentUserId: string
  ): Promise<Project | null> {
    const result = await db.query<ProjectRow>(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.git_url,
        p.invite_code,
        p.last_synced_at,
        p.question_count,
        p.created_at,
        p.created_by_id,
        u.name AS created_by_name,
        u.avatar_url AS created_by_avatar_url,
        pm.role
      FROM projects p
      JOIN project_members pm
        ON pm.project_id = p.id
       AND pm.user_id = $1
      LEFT JOIN users u
        ON u.id = p.created_by_id
      WHERE p.id = $2
      LIMIT 1
      `,
      [currentUserId, projectId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return toProject(row);
  }

  async list(currentUserId: string): Promise<Project[]> {
    const result = await this.pool.query<ProjectRow>(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.git_url,
        p.invite_code,
        p.last_synced_at,
        p.question_count,
        p.created_at,
        p.created_by_id,
        u.name AS created_by_name,
        u.avatar_url AS created_by_avatar_url,
        pm.role
      FROM projects p
      JOIN project_members pm
        ON pm.project_id = p.id
       AND pm.user_id = $1
      LEFT JOIN users u
        ON u.id = p.created_by_id
      ORDER BY p.created_at DESC
      `,
      [currentUserId]
    );

    return result.rows.map(toProject);
  }

  async findByIdForUser(projectId: string, currentUserId: string): Promise<Project | null> {
    return this.findByIdForUserInternal(this.pool, projectId, currentUserId);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const result = await this.pool.query<ProjectMemberRow>(
      `
      SELECT
        pm.user_id,
        u.name,
        u.avatar_url,
        pm.role,
        pm.joined_at
      FROM project_members pm
      LEFT JOIN users u
        ON u.id = pm.user_id
      WHERE pm.project_id = $1
      ORDER BY
        CASE pm.role WHEN 'OWNER' THEN 0 ELSE 1 END,
        pm.joined_at ASC NULLS LAST
      `,
      [projectId]
    );

    return result.rows.map((row) => ({
      id: row.user_id,
      name: row.name ?? "Unknown",
      avatarUrl: row.avatar_url ?? null,
      role: row.role,
      joinedAt: row.joined_at ? row.joined_at.toISOString() : null,
    }));
  }

  async create(input: CreateProjectInput, creator: ProjectCreator): Promise<Project> {
    const id = crypto.randomUUID();
    const projectMemberId = crypto.randomUUID();
    const inviteCode = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
        INSERT INTO projects (
          id,
          name,
          description,
          git_url,
          invite_code,
          last_synced_at,
          question_count,
          created_by_id
        )
        VALUES ($1, $2, $3, $4, $5, NULL, 0, $6)
        `,
        [
          id,
          input.name,
          input.description ?? null,
          input.gitUrl ?? null,
          inviteCode,
          creator.id,
        ]
      );

      await client.query(
        `
        INSERT INTO project_members (id, user_id, project_id, role, joined_at)
        VALUES ($1, $2, $3, 'OWNER', NOW())
        `,
        [projectMemberId, creator.id, id]
      );

      const createdProject = await this.findByIdForUserInternal(client, id, creator.id);
      if (!createdProject) {
        throw new Error("Failed to load created project");
      }
      await client.query("COMMIT");
      return createdProject;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async existsById(projectId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = $1
      ) AS exists
      `,
      [projectId]
    );

    return result.rows[0]?.exists ?? false;
  }

  async findMemberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
    const result = await this.pool.query<{ role: ProjectRole }>(
      `
      SELECT role
      FROM project_members
      WHERE project_id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [projectId, userId]
    );

    const row = result.rows[0];
    return row?.role ?? null;
  }

  async updateGitUrl(projectId: string, gitUrl: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE projects
      SET git_url = $2
      WHERE id = $1
      `,
      [projectId, gitUrl]
    );
  }
}
