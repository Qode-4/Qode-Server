export type Project = {
  id: string;
  name: string;
  description: string | null;
  gitUrl: string | null;
  inviteCode: string;
  lastSyncedAt: string | null;
  questionCount: number;
  createdAt: string;
  createdBy: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  role: "OWNER" | "MEMBER";
};

export type CreateProjectInput = {
  name: string;
  description?: string | null;
  gitUrl?: string | null;
  git?: {
    provider: "github_oauth";
    flowId: string;
    owner: string;
    repo: string;
    defaultBranch: string;
  };
};

export type ProjectMember = {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: "OWNER" | "MEMBER";
  joinedAt: string | null;
};

export type ProjectSyncStatus = "queued" | "syncing" | "done" | "failed";
export type ProjectSyncStatusView = "idle" | "queued" | "syncing" | "done" | "failed";

export type ProjectSyncErrorCode =
  | "PROJECT_SYNC_PROJECT_NOT_FOUND"
  | "PROJECT_SYNC_FORBIDDEN"
  | "PROJECT_SYNC_ALREADY_RUNNING"
  | "PROJECT_SYNC_REPO_NOT_CONFIGURED"
  | "PROJECT_SYNC_JOB_NOT_FOUND"
  | "PROJECT_SYNC_OAUTH_REAUTH_REQUIRED"
  | "PROJECT_SYNC_REPO_ACCESS_DENIED_OR_NOT_FOUND"
  | "PROJECT_SYNC_NETWORK_ERROR"
  | "PROJECT_SYNC_TIMEOUT"
  | "PROJECT_SYNC_STORAGE_ERROR"
  // 명세 A-4 한도. 이름은 화면(Qode-Fe lib/sync-errors.ts)이 기다리는 것과 같아야 한다.
  | "REPO_SIZE_LIMIT_EXCEEDED"
  | "REPO_FILE_LIMIT_EXCEEDED"
  | "REPO_EMPTY"
  // 열린 과제 13-6. 파이썬 /index 실패·타임아웃. 화면 문구는 Qode-Fe lib/sync-errors.ts
  | "PROJECT_SYNC_INDEX_FAILED"
  | "PROJECT_SYNC_UNKNOWN_ERROR";

export type ProjectSyncJob = {
  id: string;
  projectId: string;
  requestedBy: string;
  status: ProjectSyncStatus;
  progress: number;
  errorCode: ProjectSyncErrorCode | null;
  errorMessage: string | null;
  syncedCommit: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};
