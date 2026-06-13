export type Folder = {
  id: string;
  sectionId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateFolderInput = {
  name: string;
};

export type UpdateFolderInput = {
  name: string;
};
