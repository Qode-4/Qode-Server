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
};

export type ProjectMember = {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: "OWNER" | "MEMBER";
  joinedAt: string | null;
};
