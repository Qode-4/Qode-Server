import type { Pool, PoolClient } from "pg";
import type {
  CreateProjectInput,
  Project,
  ProjectMember,
  ProjectSyncErrorCode,
  ProjectSyncJob,
  ProjectSyncStatus
} from "./project.types.js";

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
  createGitConnection(input: {
    projectId: string;
    provider: "github_oauth";
    owner: string;
    repo: string;
    defaultBranch: string;
    gitUrl: string;
    tokenRefId: string;
    connectedBy: string;
  }): Promise<void>;
  getSyncTarget(projectId: string): Promise<{ projectId: string; gitUrl: string; tokenRefId: string } | null>;
  getOauthTokenByRefId(tokenRefId: string): Promise<{ accessTokenEncrypted: string; expiresAt: string | null } | null>;
  createSyncJob(input: { projectId: string; requestedBy: string }): Promise<ProjectSyncJob>;
  getLatestSyncJob(projectId: string): Promise<ProjectSyncJob | null>;
  findSyncJobById(projectId: string, jobId: string): Promise<ProjectSyncJob | null>;
  findRunningSyncJobByProject(projectId: string): Promise<ProjectSyncJob | null>;
  markSyncJobRunning(jobId: string): Promise<void>;
  updateSyncJobProgress(jobId: string, progress: number): Promise<void>;
  completeSyncJob(jobId: string, syncedCommit: string): Promise<void>;
  failSyncJob(jobId: string, errorCode: ProjectSyncErrorCode, errorMessage: string): Promise<void>;
}

type StoredProject = Omit<Project, "role">;
type StoredGitConnection = {
  projectId: string;
  gitUrl: string;
  tokenRefId: string;
};

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, StoredProject>();
  private readonly gitConnections = new Map<string, StoredGitConnection>();
  private readonly syncJobs = new Map<string, ProjectSyncJob>();
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

  async createGitConnection(input: {
    projectId: string;
    provider: "github_oauth";
    owner: string;
    repo: string;
    defaultBranch: string;
    gitUrl: string;
    tokenRefId: string;
    connectedBy: string;
  }): Promise<void> {
    const current = this.store.get(input.projectId);
    if (!current) {
      return;
    }

    this.store.set(input.projectId, {
      ...current,
      gitUrl: input.gitUrl,
    });
    this.gitConnections.set(input.projectId, {
      projectId: input.projectId,
      gitUrl: input.gitUrl,
      tokenRefId: input.tokenRefId,
    });
  }

  async getSyncTarget(projectId: string): Promise<{ projectId: string; gitUrl: string; tokenRefId: string } | null> {
    return this.gitConnections.get(projectId) ?? null;
  }

  async getOauthTokenByRefId(
    _tokenRefId: string
  ): Promise<{ accessTokenEncrypted: string; expiresAt: string | null } | null> {
    return null;
  }

  async createSyncJob(input: { projectId: string; requestedBy: string }): Promise<ProjectSyncJob> {
    const now = new Date().toISOString();
    const job: ProjectSyncJob = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      requestedBy: input.requestedBy,
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      syncedCommit: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    this.syncJobs.set(job.id, job);
    return job;
  }

  async findSyncJobById(projectId: string, jobId: string): Promise<ProjectSyncJob | null> {
    const job = this.syncJobs.get(jobId);
    if (!job || job.projectId !== projectId) {
      return null;
    }
    return job;
  }

  async findRunningSyncJobByProject(projectId: string): Promise<ProjectSyncJob | null> {
    for (const job of this.syncJobs.values()) {
      if (job.projectId === projectId && (job.status === "queued" || job.status === "syncing")) {
        return job;
      }
    }
    return null;
  }

  async getLatestSyncJob(projectId: string): Promise<ProjectSyncJob | null> {
    const jobs = Array.from(this.syncJobs.values())
      .filter((job) => job.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return jobs[0] ?? null;
  }

  async markSyncJobRunning(jobId: string): Promise<void> {
    const current = this.syncJobs.get(jobId);
    if (!current) {
      return;
    }

    const now = new Date().toISOString();
    this.syncJobs.set(jobId, {
      ...current,
      status: "syncing",
      startedAt: current.startedAt ?? now,
      updatedAt: now,
    });
  }

  async updateSyncJobProgress(jobId: string, progress: number): Promise<void> {
    const current = this.syncJobs.get(jobId);
    if (!current) {
      return;
    }

    this.syncJobs.set(jobId, {
      ...current,
      progress,
      updatedAt: new Date().toISOString(),
    });
  }

  async completeSyncJob(jobId: string, syncedCommit: string): Promise<void> {
    const current = this.syncJobs.get(jobId);
    if (!current) {
      return;
    }

    const now = new Date().toISOString();
    this.syncJobs.set(jobId, {
      ...current,
      status: "done",
      progress: 100,
      syncedCommit,
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
      updatedAt: now,
    });

    const project = this.store.get(current.projectId);
    if (project) {
      this.store.set(current.projectId, {
        ...project,
        lastSyncedAt: now,
      });
    }
  }

  async failSyncJob(jobId: string, errorCode: ProjectSyncErrorCode, errorMessage: string): Promise<void> {
    const current = this.syncJobs.get(jobId);
    if (!current) {
      return;
    }

    const now = new Date().toISOString();
    this.syncJobs.set(jobId, {
      ...current,
      status: "failed",
      errorCode,
      errorMessage,
      finishedAt: now,
      updatedAt: now,
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

type ProjectSyncJobRow = {
  id: string;
  project_id: string;
  requested_by: string;
  status: ProjectSyncStatus;
  progress: number;
  error_code: ProjectSyncErrorCode | null;
  error_message: string | null;
  synced_commit: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
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

const toProjectSyncJob = (row: ProjectSyncJobRow): ProjectSyncJob => ({
  id: row.id,
  projectId: row.project_id,
  requestedBy: row.requested_by,
  status: row.status,
  progress: row.progress,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  syncedCommit: row.synced_commit,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at ? row.started_at.toISOString() : null,
  finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  updatedAt: row.updated_at.toISOString(),
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

  async createGitConnection(input: {
    projectId: string;
    provider: "github_oauth";
    owner: string;
    repo: string;
    defaultBranch: string;
    gitUrl: string;
    tokenRefId: string;
    connectedBy: string;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO project_git_connections (
        id, project_id, provider, owner, repo, default_branch, git_url, token_ref_id, connected_by, connected_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      ON CONFLICT (project_id) DO UPDATE
      SET
        provider = EXCLUDED.provider,
        owner = EXCLUDED.owner,
        repo = EXCLUDED.repo,
        default_branch = EXCLUDED.default_branch,
        git_url = EXCLUDED.git_url,
        token_ref_id = EXCLUDED.token_ref_id,
        connected_by = EXCLUDED.connected_by,
        updated_at = NOW()
      `,
      [
        crypto.randomUUID(),
        input.projectId,
        input.provider,
        input.owner,
        input.repo,
        input.defaultBranch,
        input.gitUrl,
        input.tokenRefId,
        input.connectedBy,
      ]
    );

    await this.pool.query(
      `
      UPDATE projects
      SET git_url = $2
      WHERE id = $1
      `,
      [input.projectId, input.gitUrl]
    );
  }

  async getSyncTarget(projectId: string): Promise<{ projectId: string; gitUrl: string; tokenRefId: string } | null> {
    const result = await this.pool.query<{
      project_id: string;
      git_url: string;
      token_ref_id: string;
    }>(
      `
      SELECT project_id, git_url, token_ref_id
      FROM project_git_connections
      WHERE project_id = $1
      LIMIT 1
      `,
      [projectId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      projectId: row.project_id,
      gitUrl: row.git_url,
      tokenRefId: row.token_ref_id,
    };
  }

  async getOauthTokenByRefId(
    tokenRefId: string
  ): Promise<{ accessTokenEncrypted: string; expiresAt: string | null } | null> {
    const result = await this.pool.query<{
      access_token_encrypted: string;
      expires_at: Date | null;
    }>(
      `
      SELECT access_token_encrypted, expires_at
      FROM github_oauth_tokens
      WHERE id = $1
      LIMIT 1
      `,
      [tokenRefId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      accessTokenEncrypted: row.access_token_encrypted,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    };
  }

  async createSyncJob(input: { projectId: string; requestedBy: string }): Promise<ProjectSyncJob> {
    const id = crypto.randomUUID();
    const result = await this.pool.query<ProjectSyncJobRow>(
      `
      INSERT INTO project_sync_jobs (
        id,
        project_id,
        requested_by,
        status,
        progress,
        error_code,
        error_message,
        synced_commit,
        created_at,
        started_at,
        finished_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'queued', 0, NULL, NULL, NULL, NOW(), NULL, NULL, NOW())
      RETURNING
        id,
        project_id,
        requested_by,
        status,
        progress,
        error_code,
        error_message,
        synced_commit,
        created_at,
        started_at,
        finished_at,
        updated_at
      `,
      [id, input.projectId, input.requestedBy]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create sync job");
    }
    return toProjectSyncJob(row);
  }

  async findSyncJobById(projectId: string, jobId: string): Promise<ProjectSyncJob | null> {
    const result = await this.pool.query<ProjectSyncJobRow>(
      `
      SELECT
        id,
        project_id,
        requested_by,
        status,
        progress,
        error_code,
        error_message,
        synced_commit,
        created_at,
        started_at,
        finished_at,
        updated_at
      FROM project_sync_jobs
      WHERE id = $1
        AND project_id = $2
      LIMIT 1
      `,
      [jobId, projectId]
    );

    const row = result.rows[0];
    return row ? toProjectSyncJob(row) : null;
  }

  async findRunningSyncJobByProject(projectId: string): Promise<ProjectSyncJob | null> {
    const result = await this.pool.query<ProjectSyncJobRow>(
      `
      SELECT
        id,
        project_id,
        requested_by,
        status,
        progress,
        error_code,
        error_message,
        synced_commit,
        created_at,
        started_at,
        finished_at,
        updated_at
      FROM project_sync_jobs
      WHERE project_id = $1
        AND status IN ('queued', 'syncing')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [projectId]
    );

    const row = result.rows[0];
    return row ? toProjectSyncJob(row) : null;
  }

  async getLatestSyncJob(projectId: string): Promise<ProjectSyncJob | null> {
    const result = await this.pool.query<ProjectSyncJobRow>(
      `
      SELECT
        id,
        project_id,
        requested_by,
        status,
        progress,
        error_code,
        error_message,
        synced_commit,
        created_at,
        started_at,
        finished_at,
        updated_at
      FROM project_sync_jobs
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [projectId]
    );
    const row = result.rows[0];
    return row ? toProjectSyncJob(row) : null;
  }

  async markSyncJobRunning(jobId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE project_sync_jobs
      SET
        status = 'syncing',
        started_at = COALESCE(started_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
      `,
      [jobId]
    );
  }

  async updateSyncJobProgress(jobId: string, progress: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE project_sync_jobs
      SET
        progress = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [jobId, progress]
    );
  }

  async completeSyncJob(jobId: string, syncedCommit: string): Promise<void> {
    const result = await this.pool.query<{ project_id: string }>(
      `
      UPDATE project_sync_jobs
      SET
        status = 'done',
        progress = 100,
        synced_commit = $2,
        error_code = NULL,
        error_message = NULL,
        finished_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING project_id
      `,
      [jobId, syncedCommit]
    );

    const row = result.rows[0];
    if (!row) {
      return;
    }

    await this.pool.query(
      `
      UPDATE projects
      SET last_synced_at = NOW()
      WHERE id = $1
      `,
      [row.project_id]
    );
  }

  async failSyncJob(jobId: string, errorCode: ProjectSyncErrorCode, errorMessage: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE project_sync_jobs
      SET
        status = 'failed',
        error_code = $2,
        error_message = $3,
        finished_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      `,
      [jobId, errorCode, errorMessage]
    );
  }
}
