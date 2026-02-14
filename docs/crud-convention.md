# CRUD 견본 컨벤션

이 문서는 `sample-item` 모듈을 기준으로, 새 도메인 CRUD를 추가할 때 따를 기본 구조를 정의합니다.

## 폴더 구조

```text
src/
├─ common/
│  ├─ error-handler.ts
│  └─ http-error.ts
├─ config/
│  └─ env.ts
├─ modules/
│  └─ sample-item/
│     ├─ sample-item.route.ts
│     ├─ sample-item.schema.ts
│     ├─ sample-item.service.ts
│     ├─ sample-item.repository.ts
│     └─ sample-item.types.ts
└─ index.ts
```

## 레이어 역할

- `schema`: 요청 검증(zod)
- `route`: HTTP 입출력 처리, schema 호출
- `service`: 비즈니스 로직, 예외 처리
- `repository`: 데이터 접근 계층(DB/in-memory 교체 지점)
- `common`: 공통 에러/핸들러

## 구현 규칙

1. 라우트에서 `request.body/params/query`를 바로 쓰지 말고 zod로 먼저 파싱
2. `service`에서 도메인 규칙과 `404` 등 예외를 결정
3. `repository`는 인터페이스를 두고 구현체를 분리
4. 에러 응답은 `HttpError` + `registerErrorHandler`로 통일

현재 샘플은 `DATABASE_URL`이 설정되면 PostgreSQL 저장소(`PgSampleItemRepository`)를 사용하고,
설정되지 않으면 in-memory 저장소로 동작합니다.

## 샘플 엔드포인트

- `GET /api/sample-items`
- `GET /api/sample-items/:id`
- `POST /api/sample-items`
- `PATCH /api/sample-items/:id`
- `DELETE /api/sample-items/:id`

## 빠른 테스트

```bash
curl -X POST http://localhost:3000/api/sample-items \
  -H "content-type: application/json" \
  -d '{"title":"first item","description":"sample"}'
```

```bash
curl http://localhost:3000/api/sample-items
```
