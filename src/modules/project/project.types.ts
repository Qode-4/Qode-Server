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
  role: "OWNER";
};

export type CreateProjectInput = {
  name: string;
  description?: string | null;
  gitUrl?: string | null;
  createdBy: {
    id: string;
    name: string;
    avatarUrl?: string | null;
  };
};
