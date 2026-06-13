# macOS 개발 환경 설치 가이드

이 문서는 "아무것도 설치되지 않은 macOS"를 기준으로 작성되었습니다.  
기준 날짜: 2026-02-13  
프로젝트 기준 런타임: Node.js `22.22.0`, pnpm `10.x`

## 1. 터미널 실행

`Terminal` 앱(iTerm 사용 중이면 iTerm)을 실행합니다.

## 2. Homebrew 설치

Homebrew가 없다면 설치:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

설치 후 확인:

```bash
brew --version
```

## 3. Git 설치

```bash
brew install git
git --version
```

## 4. nvm 설치

```bash
brew install nvm
mkdir -p ~/.nvm
```

`~/.zshrc`에 아래 추가:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix nvm)/nvm.sh" ] && . "$(brew --prefix nvm)/nvm.sh"
[ -s "$(brew --prefix nvm)/etc/bash_completion.d/nvm" ] && . "$(brew --prefix nvm)/etc/bash_completion.d/nvm"
```

적용:

```bash
source ~/.zshrc
nvm --version
```

## 5. Node.js 22.22.0 설치/사용

```bash
nvm install 22.22.0
nvm use 22.22.0
node -v
npm -v
```

`node -v`가 `v22.22.0`으로 나와야 합니다.

## 6. pnpm 활성화

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

## 7. 저장소 클론

원하는 작업 폴더에서:

```bash
git clone <REPO_URL>
cd Qode-Server
```

이미 클론된 경우 이 단계는 건너뜁니다.

## 8. 의존성 설치

```bash
pnpm install
```

## 9. 로컬 PostgreSQL 준비

로컬 개발 서버는 기본적으로 로컬 PostgreSQL DB를 사용합니다.

```bash
brew install postgresql@16
brew services start postgresql@16
createdb qode_server
```

기본 접속 URL은 아래와 같습니다.

```text
postgresql://postgres:postgres@localhost:5432/qode_server
```

사용자/비밀번호가 다르면 `DATABASE_URL`을 로컬 환경에 맞게 수정합니다.

## 10. 환경변수 파일 생성

```bash
cp .env.example .env
```

로컬 DB는 TLS 없이 접속하므로 `DATABASE_SSL_MODE=disable`을 사용합니다.

개인 로컬 DB 계정이 기본값과 다르면 `.env.local`을 만들고 아래처럼 덮어씁니다.
이 파일은 git에 커밋되지 않습니다.

```bash
DATABASE_URL=postgresql://내맥사용자명@localhost:5432/qode_server
DATABASE_SSL_MODE=disable
```

## 11. 개발 서버 실행

```bash
pnpm dev
```

헬스체크:

```bash
curl http://localhost:3000/health
```

정상 예시: `ok: true`

## 12. 필수 점검 명령

```bash
pnpm typecheck
pnpm build
```

## 자주 발생하는 문제

1. `nvm` 명령이 안 잡힘
- `source ~/.zshrc` 재실행
- 터미널 완전 종료 후 재실행

2. `corepack` 명령이 안 잡힘
- `nvm use 22.22.0` 다시 실행 후 터미널 재시작

3. `brew` 명령이 안 잡힘
- Homebrew 설치 직후 출력된 PATH 안내를 `~/.zprofile`에 반영

4. Apple Silicon(M1/M2/M3)에서 설치 경로 혼동
- `brew --prefix` 결과 기준으로 사용 (`/opt/homebrew`가 일반적)

## 팀 공통 규칙

- Node 버전은 반드시 `22.22.0` 사용
- 패키지 매니저는 `pnpm`만 사용
- `.env` 파일은 커밋 금지 (`.gitignore` 반영됨)
