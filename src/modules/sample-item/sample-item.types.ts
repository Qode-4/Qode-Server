// 저장소/서비스/라우트 계층에서 공통으로 사용하는 API 응답 타입입니다.
export type SampleItem = {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

// 새 항목 생성 시 필요한 입력 타입입니다.
export type CreateSampleItemInput = {
  title: string;
  description?: string;
};

// PATCH 업데이트에 사용하는 부분 입력 타입입니다.
export type UpdateSampleItemInput = {
  title?: string;
  description?: string;
};
