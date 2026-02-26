| 구분 | 기술 | 역할 | 비교 |
| --- | --- | --- | --- |
| CI | GitHub Actions | 테스트/빌드/배포 트리거 | `main` merge 시 |
| CD 대상 | AWS EC2 | 앱 실행 서버 | AWS Linux |
| 프로세스 매니저 | PM2 | 무중단 재시작 및 로그 관리 |  |
| 런타임 | Node.js 22.22.0 | 서버 실행 |  |
| 패키지 매니저 | pnpm 10.x | 의존성 설치 및 빌드 | `corepack` 사용 |
| 배포 방식 | SSH pull deploy | 서버에서 `git pull` 후 재시작 |  |
| 암호 | Github Secrets | SSH 키, 호스트, 환경 변수 |  |