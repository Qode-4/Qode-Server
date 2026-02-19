# 1. 현재 PM2 프로세스 확인
pm2 list

# 2. 기존 앱 중지/삭제 (앱 이름이 qode-server가 아닐 수 있으니 list 보고 이름 맞춰서)
pm2 stop qode-server
pm2 delete qode-server

# 전체 다 지우려면 (주의)
pm2 delete all

# 3. 프로젝트에서 재빌드
cd /path/to/Qode-Server
pnpm install
pnpm build

# 4. 다시 실행
pm2 start dist/index.js --name qode-server

# 5. 부팅시 자동시작 저장
pm2 save

# 6. 로그 확인
pm2 logs qode-server
