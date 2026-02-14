export type SampleItem = {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSampleItemInput = {
  title: string;
  description?: string;
};

export type UpdateSampleItemInput = {
  title?: string;
  description?: string;
};

