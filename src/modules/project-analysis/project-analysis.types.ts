export type ProjectAnalysisStatus = "building" | "ready" | "failed";

export type ProjectAnalysisSummary = {
  project_overview: string;
  architecture: string[];
  core_modules: Array<{
    path: string;
    purpose: string;
  }>;
  key_flows: string[];
  risks: string[];
  recommended_next_steps: string[];
};

export type ProjectAnalysis = {
  id: string;
  projectId: string;
  version: number;
  status: ProjectAnalysisStatus;
  summary: ProjectAnalysisSummary | null;
  sourceCommit: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
