export class HttpError extends Error {
  // 전역 에러 핸들러가 응답에 사용하는 HTTP 상태 코드입니다.
  statusCode: number;
  // 추가적인 기계 판독용 에러 상세 정보(선택)입니다.
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}
