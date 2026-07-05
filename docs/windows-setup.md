# Windows 개발 환경 설치 가이드

이 문서는 "아무것도 설치되지 않은 Windows PC"를 기준으로 작성되었습니다.  
기준 날짜: 2026-02-13  
프로젝트 기준 런타임: Node.js `22.22.0`, pnpm `10.x`

## 1. PowerShell 관리자 권한으로 실행

시작 메뉴에서 `PowerShell` 검색 후 `관리자 권한으로 실행`합니다.

## 2. Git 설치

```powershell
winget install --id Git.Git -e
```

설치 후 새 PowerShell 창에서 확인:

```powershell
git --version
```

## 3. nvm-windows 설치

Node 버전 고정을 위해 `nvm-windows`를 사용합니다.

```powershell
winget install --id CoreyButler.NVMforWindows -e
```

설치 후 PowerShell을 완전히 종료했다가 다시 열고 확인:

```powershell
nvm version
```

## 4. Node.js 22.22.0 설치/사용

```powershell
nvm install 22.22.0
nvm use 22.22.0
node -v
npm -v
```

`node -v`가 `v22.22.0`으로 나와야 합니다.

## 5. pnpm 활성화

```powershell
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

## 6. 저장소 클론

원하는 작업 폴더에서:

```powershell
git clone <REPO_URL>
cd Qode-Server
```

이미 클론된 경우 이 단계는 건너뜁니다.

## 7. 의존성 설치

```powershell
pnpm install
```

## 8. 로컬 PostgreSQL 준비

로컬 개발 서버는 기본적으로 로컬 PostgreSQL DB를 사용합니다.

```powershell
winget install --id PostgreSQL.PostgreSQL.16 -e
```

설치 시 사용자/비밀번호를 설정한 뒤 새 PowerShell에서 DB를 생성합니다.

```powershell
& "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres qode_server
```

기본 접속 URL은 아래와 같습니다.

```text
postgresql://postgres:postgres@localhost:5432/qode_server
```

설치 시 지정한 비밀번호가 다르면 `DATABASE_URL`을 로컬 환경에 맞게 수정합니다.

`createdb` 명령이 인식되지 않으면 PostgreSQL `bin` 폴더가 PATH에 잡히지 않은 상태입니다.
현재 PowerShell 창에서만 임시로 잡으려면 아래를 실행한 뒤 다시 시도합니다.

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
createdb -U postgres qode_server
```

## 9. 환경변수 파일 생성

```powershell
Copy-Item .env.example .env
```

로컬 DB는 TLS 없이 접속하므로 `DATABASE_SSL_MODE=disable`을 사용합니다.

개인 로컬 DB 계정이 기본값과 다르면 `.env.local`을 만들고 아래처럼 덮어씁니다.
이 파일은 git에 커밋되지 않습니다.

```powershell
DATABASE_URL=postgresql://postgres:내비밀번호@localhost:5432/qode_server
DATABASE_SSL_MODE=disable
```

## 10. 개발 서버 실행

```powershell
pnpm dev
```

헬스체크:

```powershell
curl http://localhost:3000/health
```

정상 예시: `ok: true`

## 11. 필수 점검 명령

```powershell
pnpm typecheck
pnpm build
```

## 로컬 DB 켜서 테스트 하는 방법

```
docker rm -f qode-test-db
docker run -d --name qode-test-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=test_db -p 5432:5432 postgres:16
pnpm vitest run src/modules/team-chat/team-chat.repository.test.ts
```

## 카프카 설치

```
docker run -d --name kafka -p 9092:9092 apache/kafka:latest
docker ps | findstr kafka
pnpm add kafkajs
```

## 카프카 토픽 생성

```
docker exec -it kafka /opt/kafka/bin/kafka-topics.sh --create --topic team-chat-message --bootstrap-server localhost:9092 --partitions 1 --replication-factor 1
```

## 자주 발생하는 문제

1. `nvm` 명령이 안 잡힘
- PowerShell을 완전히 종료 후 재실행
- 그래도 안 되면 Windows 로그아웃/재로그인

2. `corepack` 명령이 안 잡힘
- `nvm use 22.22.0`을 다시 실행 후 새 터미널에서 재시도

3. `pnpm install` 권한 오류
- 프로젝트 폴더가 OneDrive 동기화 경로면 일반 경로(예: `C:\dev`)로 이동 권장

4. PowerShell 실행 정책 오류
- 관리자 PowerShell에서 아래 1회 실행:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 팀 공통 규칙

- Node 버전은 반드시 `22.22.0` 사용
- 패키지 매니저는 `pnpm`만 사용
- `.env` 파일은 커밋 금지 (`.gitignore` 반영됨)
