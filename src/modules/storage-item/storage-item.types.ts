export type StorageItemType = "github_repo" | "figma" | "figjam";

export type GithubRepoMetadata = {
  owner: string;
  repo: string;
  defaultBranch: string;
};

export type FigmaMetadata = {
  fileKey: string;
  nodeId?: string;
};

export type FigjamMetadata = {
  fileKey: string;
};

export type StorageItemMetadata = GithubRepoMetadata | FigmaMetadata | FigjamMetadata;

export type StorageItemCreator = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export type StorageItem = {
  id: string;
  projectId: string;
  type: StorageItemType;
  title: string;
  url: string;
  metadata: StorageItemMetadata;
  createdBy: StorageItemCreator;
  createdAt: string;
  updatedAt: string;
};

export type CreateStorageItemInput =
  | {
      type: "github_repo";
      title: string;
      url: string;
      metadata: GithubRepoMetadata;
    }
  | {
      type: "figma";
      title: string;
      url: string;
      metadata: FigmaMetadata;
    }
  | {
      type: "figjam";
      title: string;
      url: string;
      metadata: FigjamMetadata;
    };

export type UpdateStorageItemInput = {
  title: string;
};
