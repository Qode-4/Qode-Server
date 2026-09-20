# AGENTS.md

이 저장소에서 작업하는 AI 코딩 에이전트를 위한 안내다.

## 명령어

패키지 매니저는 pnpm 10.29.3 고정, Node 22 (`.nvmrc`).

```bash
pnpm dev          # tsx watch src/index.ts
pnpm typecheck    # tsc --noEmit (CI가 build 전에 실행)
pnpm build        # tsc → dist/
pnpm start        # node dist/index.js
```

`test` 스크립트는 없다. vitest를 직접 호출한다:

```bash
pnpm vitest run                                        # 전체
pnpm vitest run src/modules/team-chat/team-chat.repository.test.ts   # 단일 파일
pnpm vitest run -t "테스트 이름"                        # 이름으로 필터
```

테스트는 실제 PostgreSQL에 붙는다(`postgresql://postgres:postgres@localhost:5432/test_db`, `vitest.config.ts`에 하드코딩). `beforeAll`에서 `initializeCoreSchema`로 스키마를 만들고 `beforeEach`에서 `TRUNCATE ... CASCADE`로 초기화한다. DB 없이는 리포지토리 테스트가 실패한다.

API 문서는 서버 기동 후 `/docs` (Swagger UI), 헬스체크는 `/health`.

### Kafka는 선택이지만 팀 채팅에는 필수

브로커 주소는 `KAFKA_BROKERS`(기본 `127.0.0.1:9092`, 쉼표 구분)로 지정한다.
`initSocketServer`(`src/lib/socket/socket.server.ts`)가 producer/consumer 연결을 `try/catch`로 감싸므로
**브로커가 없어도 서버는 뜬다.** 대신 `kafkaReady=false`로 남아 `team:message:send`가 전부
`team:message:error`로 되돌아온다. 팀 채팅이 조용히 안 되면 기동 로그의 "Kafka 연결 실패" 경고부터 본다.
개인 AI 채팅(`message:send`)은 Kafka를 거치지 않는다.

#### macOS — Homebrew (Docker 불필요)

Kafka 4.x는 KRaft 단독이라 ZooKeeper를 따로 띄우지 않는다.

```bash
brew install kafka
brew services start kafka        # 로그인 시 자동 기동까지 걸린다

# 확인
brew services list | grep kafka          # started 여야 한다
lsof -nP -iTCP:9092 -sTCP:LISTEN         # java가 9092를 잡고 있어야 한다
```

토픽은 `num.partitions=1` + 자동 생성이라 보통 손댈 게 없다. 직접 만들거나 확인하려면
(Homebrew판 CLI는 `.sh`가 붙지 않는다):

```bash
kafka-topics --list --bootstrap-server localhost:9092
kafka-topics --create --topic team-chat-message \
  --bootstrap-server localhost:9092 --partitions 1 --replication-factor 1
```

**함정 — 브로커는 멀쩡한데 CLI만 죽는 경우.** `brew services`는 자기 `openjdk`로 브로커를 띄우지만,
`kafka-topics` 같은 CLI는 셸의 `JAVA_HOME`을 따라간다. `~/.zshrc`에 옛 JDK 경로가 박혀 있으면
브로커는 잘 돌면서 CLI만 `bin/java: No such file or directory`로 죽는다:

```bash
export JAVA_HOME=$(brew --prefix)/opt/openjdk
```

#### Docker로 띄우는 경우

`docs/windows-setup.md`의 「카프카 설치」·「카프카 토픽 생성」 절을 따른다. macOS에서도 같은 명령이 동작한다.
루트의 `docker-compose.yml`은 **0바이트 빈 파일이라 `docker compose up`은 아무것도 안 띄운다.**

## 아키텍처

Fastify 5 + 순수 `pg` (ORM·마이그레이션 도구 없음) + TypeScript ESM.

### ESM 규칙

`"type": "module"` + `moduleResolution: NodeNext`. **모든 상대 import는 `.js` 확장자를 붙여야 한다** (`./foo.service.js`). 소스가 `.ts`여도 마찬가지.

### 모듈 레이어 (`docs/crud-convention.md`, `sample-item` 모듈이 견본)

`src/modules/<domain>/`에 `route` / `schema` / `service` / `repository` / `types` 5파일.

- `route`: HTTP 입출력. Fastify JSON Schema를 인라인으로 선언(Swagger 문서 + 응답 직렬화용)하고, **실제 검증은 zod로 다시 한다** — `createXBodySchema.parse(request.body)`. 두 스키마가 공존하는 구조이므로 필드 추가 시 양쪽을 함께 고쳐야 한다.
- `service`: 도메인 규칙, `HttpError`로 상태코드 결정.
- `repository`: `interface XRepository` + `PgXRepository implements` 로 분리. snake_case 행 → camelCase 객체 변환은 리포지토리 안의 `toX()` 매퍼가 담당.

응답 형식은 성공 `{ ok: true, data }`, 실패는 `registerErrorHandler`가 `{ status, ok: false, error, message, details }`로 정규화(`ZodError` → 400 자동).

### 조립 지점: `src/index.ts`

DI 프레임워크가 없다. `src/index.ts`가 유일한 composition root로, Pool → 리포지토리 → 서비스 → `registerXRoutes(app, deps)` 순서로 손으로 엮는다. 새 모듈은 여기에 등록해야 살아난다.

선택 의존성은 env 유무에 따라 `null`로 떨어지고 기능이 통째로 비활성화된다:
- `OPENAI_API_KEY` 없음 → `projectAnalysisService = null` → `/api/project-analysis/*` 라우트 자체가 등록되지 않음
- `ANALYSIS_SERVER_URL`/`ANALYSIS_SERVER_INTERNAL_TOKEN` 없음 → 동기화 완료 후 인덱싱 콜백이 분석 서버 대신 로컬 분석 서비스로 폴백

### DB 스키마

마이그레이션 파일이 없다. `src/modules/core-schema/core-schema.repository.ts`의 `initializeCoreSchema(pool)`이 부팅 시마다 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`로 전체 스키마를 멱등하게 만든다. **테이블·컬럼 추가는 이 파일에 추가하는 것이 유일한 경로**이고, 기존 컬럼 변경/삭제는 이 방식으로 표현되지 않으니 주의.

### 인증

Fastify 플러그인이나 `preHandler` 데코레이터를 쓰지 않는다. 각 route 파일이 로컬 `getAccessToken(authorization)` 헬퍼로 `Bearer` 토큰을 꺼내 `authService.getMe(token)`을 핸들러마다 직접 호출한다. 보호된 엔드포인트를 추가할 때 기존 route 파일의 이 패턴을 그대로 따라간다.

JWT는 access + refresh 2종. `users.token_version`으로 전역 무효화, `user_refresh_tokens`에 해시 저장.

### 외부 연동

- **Python RAG/분석 서버** (`RAG_SERVICE_URL`, `ANALYSIS_SERVER_URL`): `RagSearchClient.searchChunks`로 청크 검색 → `trimContext` → `buildRagMessages` → `OpenAiClient.streamChat` 스트리밍. Python 응답은 `normalizeSearchResult()`로 내부 타입 변환 후 사용한다. 파이프라인 조립도 `src/index.ts`에 있고 각 단계가 langsmith `traceable`로 감싸져 있다(`LANGSMITH_*` 환경변수는 `config/env.ts` 스키마에 없고 SDK가 `process.env`에서 직접 읽는다).
- **GitHub OAuth Device Flow** + 레포 동기화: `ProjectSyncCoordinator`가 `SYNC_REPO_BASE_DIR` 아래로 클론/풀하고, 완료 시 인덱싱 잡을 트리거.
- **실시간**: `src/lib/socket/socket.server.ts` (socket.io). 팀 채팅 메시지는 Kafka(`team-chat-message` 토픽)를 거쳐 컨슈머가 DB 저장 + 브로드캐스트한다.

### 환경변수

`src/config/load-env.ts`를 **가장 먼저** import해야 한다(`.env` → 비프로덕션이면 `.env.local` 순으로 override). `src/config/env.ts`가 zod로 엄격 파싱하며 실패 시 부팅이 죽는다. 새 환경변수는 `envSchema`와 `.env.example` 양쪽에 추가한다.

## 자주 놓치는 것

- 이 서버는 [Qode-python](../Qode-python)(RAG 검색·인덱싱)과 짝이다. `ANALYSIS_SERVER_INTERNAL_TOKEN`과 `SYNC_REPO_BASE_DIR`은 Qode-python `.env`의 `QODE_INTERNAL_TOKEN`·저장소 루트와 일치해야 한다. 값이 어긋나면 동기화는 성공하는데 인덱싱만 401/경로 오류로 죽는다.
- auth 라우트만 `/api` 접두어가 없다(`/auth/login`, `/auth/me` …). 나머지는 전부 `/api/*`.
- `.env.local`은 비프로덕션에서 `.env`를 덮어쓴다. "설정을 바꿨는데 안 먹는다"면 `.env.local`을 먼저 본다.
- 사용자용 개요는 `README.md`, 컨벤션·함정은 이 파일. 둘을 고칠 때 서로 어긋나지 않게 한다.

## 배포

`main` 푸시 → GitHub Actions(`.github/workflows/deploy.yml`) → typecheck/build 후 EC2에 SSH로 `git pull` + `pm2 reload qode-server`. 작업 브랜치는 `develop`.

## 참고 문서

`docs/crud-convention.md`(CRUD 견본), `docs/windows-setup.md`·`docs/macos-setup.md`(초기 설치), `docs/aws-server.md`.
