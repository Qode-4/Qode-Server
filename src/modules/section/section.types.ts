import type { Folder } from "../folder/folder.types.js";

export type Section = {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSectionInput = {
  name: string;
};

export type UpdateSectionInput = {
  name: string;
};

export type SectionTreeItem = Section & {
  folders: Folder[];
};
