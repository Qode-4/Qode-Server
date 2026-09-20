# Qode-Server

Qode의 백엔드 API 서버. Fastify 5 + PostgreSQL(순수 `pg`) + TypeScript ESM.

GitHub 레포를 연결한 프로젝트를 만들고, 코드를 동기화·인덱싱해 RAG 기반으로 질문에 답하고, 팀 채팅을 실시간으로 중계한다. 코드 분석·검색은 별도 Python 서버([Qode-python](../Qode-python))가 맡고, 이 서버는 인증·프로젝트·채팅·오케스트레이션을 담당한다.

## 요구 사항

| 항목 | 버전 / 비고 |
| --- | --- |
| Node.js | 22 (`.nvmrc`) |
| pnpm | 10.29.3 (`packageManager` 고정, `corepack enable`) |
| PostgreSQL | 로컬 개발 기본 `postgresql://postgres:postgres@localhost:5432/qode_server` |
| Kafka | 팀 채팅용. 없어도 서버는 뜨고 팀 채팅만 비활성 |
| Qode-python | RAG 검색·인덱싱. 없어도 서버는 뜨고 AI 답변·인덱싱이 비활성 |

OS별 설치 절차는 `docs/macos-setup.md`, `docs/windows-setup.md`에 있다.

## 빠른 시작

```bash
corepack enable
pnpm install

cp .env.example .env      # 필수 값 채우기 (아래 환경변수 절 참고)
createdb qode_server      # 스키마는 부팅 시 자동 생성

pnpm dev                  # http://localhost:3000
```

- 헬스체크: `GET /health`
- API 문서(Swagger UI): `http://localhost:3000/docs` (production에서는 미노출)

마이그레이션 도구가 없다. 부팅할 때마다 `src/modules/core-schema/core-schema.repository.ts`의 `initializeCoreSchema`가 `CREATE TABLE IF NOT EXISTS`로 스키마를 멱등하게 만든다. 테이블·컬럼 추가는 이 파일에 한다.

## 명령어

```bash
pnpm dev          # tsx watch src/index.ts
pnpm typecheck    # tsc --noEmit
pnpm build        # tsc → dist/
pnpm start        # node dist/index.js

pnpm vitest run                       # 테스트 전체 (test 스크립트 없음, 직접 호출)
pnpm vitest run src/modules/chat      # 경로 필터
```

테스트는 실제 PostgreSQL `localhost:5432/test_db`에 붙는다(`vitest.config.ts`에 하드코딩). DB가 없으면 리포지토리 테스트가 실패한다.

## 환경변수

`.env`를 읽고, production이 아니면 `.env.local`로 덮어쓴다. `src/config/env.ts`가 zod로 엄격 파싱하며 누락되면 부팅이 죽는다. 새 변수는 `envSchema`와 `.env.example` 양쪽에 추가한다.

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `PORT`, `NODE_ENV`, `CORS_ALLOWED_ORIGINS` | | 기본 3000 / development / `http://localhost:5173` |
| `DATABASE_URL` | O | PostgreSQL 연결 URL |
| `DATABASE_SSL_MODE`, `DATABASE_SSL_REJECT_UNAUTHORIZED`, `DATABASE_SSL_CA_PATH` | | RDS 등 TLS 연결 시 사용 |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN` | O | access / refresh 토큰 |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_SCOPES` | O | GitHub OAuth Device Flow |
| `TOKEN_ENCRYPTION_KEY` | O | 저장된 GitHub 토큰 암호화 키(32바이트 base64). 바꾸면 기존 토큰 복호화 불가 |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | | 없으면 AI 채팅 답변·`/api/projects/:id/analyze` 라우트 비활성 |
| `RAG_SERVICE_URL` | | Qode-python 검색 엔드포인트 |
| `ANALYSIS_SERVER_URL`, `ANALYSIS_SERVER_INTERNAL_TOKEN` | | Qode-python 인덱싱 서버. 토큰은 Qode-python의 `QODE_INTERNAL_TOKEN`과 일치해야 함 |
| `SYNC_REPO_BASE_DIR`, `SYNC_WORKER_ENABLED`, `SYNC_MAX_CONCURRENCY` | | 레포 클론 위치·동기화 워커. 경로는 Qode-python의 저장소 루트와 일치해야 함 |
| `KAFKA_BROKERS` | | 팀 채팅 브로커. 기본 `127.0.0.1:9092`, 쉼표로 여러 개 |
| `LANGSMITH_*` | | langsmith SDK가 `process.env`에서 직접 읽음. `LANGSMITH_TRACING=false`면 무시 |

## 아키텍처

```
src/
├── index.ts                 # 유일한 조립 지점(composition root). Pool → 리포지토리 → 서비스 → 라우트 등록
├── config/                  # load-env(가장 먼저 import), env(zod 스키마)
├── common/                  # HttpError, 에러 핸들러
├── lib/
│   ├── db.ts                # pg Pool
│   ├── openai-client.ts     # 스트리밍 채팅
│   ├── analysis-server-client.ts   # Qode-python 인덱싱 호출
│   ├── kafka/               # kafkajs producer/consumer, team-chat-message 토픽
│   └── socket/              # socket.io 서버
└── modules/<domain>/        # route / schema / service / repository / types 5파일
```

**모듈 규칙**은 `docs/crud-convention.md`에, 견본은 `sample-item` 모듈에 있다. route는 Fastify JSON Schema(Swagger·직렬화용)와 zod(실제 검증)를 함께 선언하므로 필드를 추가하면 둘 다 고친다. 응답은 성공 `{ ok: true, data }`, 실패 `{ ok: false, status, error, message, details }`로 통일된다.

**인증**은 플러그인 없이 각 라우트 핸들러가 `Authorization: Bearer` 토큰을 꺼내 `authService.getMe`를 직접 호출한다. `users.token_version`으로 전체 무효화, refresh 토큰은 해시로 저장한다.

**DI 프레임워크가 없다.** 새 모듈은 `src/index.ts`에 등록해야 살아난다. 선택 의존성(OpenAI, 분석 서버)은 env가 비어 있으면 `null`이 되고 관련 기능이 통째로 꺼진다.

### 주요 흐름

- **프로젝트 동기화**: `POST /api/projects/:id/sync` → `ProjectSyncCoordinator`가 `SYNC_REPO_BASE_DIR` 아래로 clone/pull → 완료 시 Qode-python에 인덱싱 잡 요청(분석 서버가 없으면 로컬 `ProjectAnalysisService`로 폴백).
- **AI 채팅(RAG)**: `POST /api/chats/me/:id/messages` → Qode-python에서 청크 검색 → `trimContext` → 프롬프트 조립 → OpenAI 스트리밍 → 답변 뒤에 출처(`sources`) 전송. 각 단계는 langsmith `traceable`로 감싸져 있다.
- **팀 채팅**: socket.io `team:message:send` → Kafka `team-chat-message` 토픽 → 컨슈머가 DB 저장 후 방에 `team:message:receive` 브로드캐스트. Kafka 연결 실패 시 `team:message:error`를 돌려준다.

## API 개요

전체 스펙은 `/docs`에서 확인한다. 경로별 담당 모듈:

| 경로 | 모듈 |
| --- | --- |
| `/auth/{signup,login,refresh,logout,me}` | auth (`/api` 접두어 없음) |
| `/api/github/oauth/*` | github-oauth (Device Flow, 레포 목록) |
| `/api/projects`, `/api/projects/:id/{sync,members,invite,analyze,analysis}` | project, project-analysis |
| `/api/invite/:code`, `/api/invite/:code/join` | project (초대 링크) |
| `/api/projects/:projectId/sections`, `/api/sections/:sectionId/folders`, `/api/folders/:folderId` | section, folder |
| `/api/projects/:projectId/storage-items` | storage-item |
| `/api/chats/me/*` | chat (개인 AI 채팅) |
| `/api/projects/:projectId/chats`, `/api/chats/:chatId/*` | team-chat (팀 채팅방·참여자) |
| `/health`, `/internal/analysis-server/health` | system |

Socket.io 이벤트: `room:join`, `message:send` / `message:receive`, `team:message:send` / `team:message:receive` / `team:message:error`.

## 스크립트

| 파일 | 용도 |
| --- | --- |
| `scripts/batch-qa-test.mjs` | `scripts/questions.txt`의 질문을 순서대로 던져 답변을 CSV로 저장 |
| `scripts/run-langsmith-eval.mjs` | 4W 평가 매트릭스(`scripts/eval/qode-4w-eval.csv`)를 LangSmith에 올리고 correctness 채점 |
| `scripts/test-oauth-sync.sh`, `scripts/test-project-invite.sh` | OAuth 동기화·초대 흐름 수동 검증 |

사용법과 필요한 환경변수는 각 파일 머리 주석에 있다. 결과 CSV(`*results*.csv`)는 gitignore 대상이다.

## 배포

작업 브랜치는 `develop`, 배포 브랜치는 `main`이다. `main`에 푸시하면 GitHub Actions(`.github/workflows/deploy.yml`)가 typecheck·build 후 EC2에 SSH로 접속해 `git pull`과 `pm2 reload qode-server`를 실행한다. 서버 구성은 `docs/aws-server.md`에 있다.

## 문서

- `AGENTS.md`: AI 코딩 에이전트용 상세 안내(아키텍처·컨벤션·함정)
- `docs/crud-convention.md`: CRUD 모듈 작성 견본
- `docs/macos-setup.md`, `docs/windows-setup.md`: OS별 초기 설치
- `docs/aws-server.md`: EC2·PM2 배포 환경
