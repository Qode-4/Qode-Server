import type { Pool } from "pg";
import type { ProjectAnalysis, ProjectAnalysisStatus, ProjectAnalysisSummary } from "./project-analysis.types.js";

export interface ProjectAnalysisRepository {
  findByProjectId(projectId: string): Promise<ProjectAnalysis | null>;
  upsertAnalysis(input: {
    projectId: string;
    status: ProjectAnalysisStatus;
    summary: ProjectAnalysisSummary | null;
    sourceCommit: string | null;
    errorMessage: string | null;
  }): Promise<ProjectAnalysis>;
}

type ProjectAnalysisRow = {
  id: string;
  project_id: string;
  version: number;
  status: ProjectAnalysisStatus;
  summary: ProjectAnalysisSummary | null;
  source_commit: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

const toProjectAnalysis = (row: ProjectAnalysisRow): ProjectAnalysis => ({
  id: row.id,
  projectId: row.project_id,
  version: row.version,
  status: row.status,
  summary: row.summary,
  sourceCommit: row.source_commit,
  errorMessage: row.error_message,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PgProjectAnalysisRepository implements ProjectAnalysisRepository {
  constructor(private readonly pool: Pool) {}

  async findByProjectId(projectId: string): Promise<ProjectAnalysis | null> {
    const result = await this.pool.query<ProjectAnalysisRow>(
      `
      SELECT id, project_id, version, status, summary, source_commit, error_message, created_at, updated_at
      FROM project_analysis
      WHERE project_id = $1
      LIMIT 1
      `,
      [projectId]
    );

    const row = result.rows[0];
    return row ? toProjectAnalysis(row) : null;
  }

  async upsertAnalysis(input: {
    projectId: string;
    status: ProjectAnalysisStatus;
    summary: ProjectAnalysisSummary | null;
    sourceCommit: string | null;
    errorMessage: string | null;
  }): Promise<ProjectAnalysis> {
    const result = await this.pool.query<ProjectAnalysisRow>(
      `
      INSERT INTO project_analysis (
        id, project_id, version, status, summary, source_commit, error_message, created_at, updated_at
      )
      VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, NOW(), NOW())
      ON CONFLICT (project_id) DO UPDATE
      SET
        version = project_analysis.version + 1,
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        source_commit = EXCLUDED.source_commit,
        error_message = EXCLUDED.error_message,
        updated_at = NOW()
      RETURNING id, project_id, version, status, summary, source_commit, error_message, created_at, updated_at
      `,
      [
        crypto.randomUUID(),
        input.projectId,
        input.status,
        input.summary ? JSON.stringify(input.summary) : null,
        input.sourceCommit,
        input.errorMessage,
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to upsert project analysis");
    }

    return toProjectAnalysis(row);
  }
}
