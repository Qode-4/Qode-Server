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

## 8. 환경변수 파일 생성

```powershell
Copy-Item .env.example .env
```

현재는 DB 준비 전이라 `.env`의 `DATABASE_URL`은 비워둬도 개발 서버 실행이 가능합니다.

## 9. 개발 서버 실행

```powershell
pnpm dev
```

헬스체크:

```powershell
curl http://localhost:3000/health
```

정상 예시: `ok: true`

## 10. 필수 점검 명령

```powershell
pnpm typecheck
pnpm build
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
