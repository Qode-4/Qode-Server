import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // vitest 4의 기본 exclude는 node_modules·.git 뿐이라 dist/ 의 옛 컴파일본까지
        // 테스트로 수집된다. 원본만 본다.
        include: ["src/**/*.{test,spec}.ts"],
        // DB 테스트 세 개(team-chat.repository·socket.server·kafka)가 같은 test_db 를
        // beforeEach 마다 TRUNCATE 한다. 병렬로 돌면 서로의 데이터를 지워 결과가 회차마다
        // 달라진다. 파일을 하나씩 돌려 간섭을 없앤다.
        // ponytail: 전역 직렬화. 테스트가 늘어 느려지면 파일별 트랜잭션+ROLLBACK 으로 옮긴다
        fileParallelism: false,
        env: {
            DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test_db",
            JWT_SECRET: "test-secret",
            JWT_EXPIRES_IN: "1h",
            JWT_REFRESH_SECRET: "test-refresh-secret",
            JWT_REFRESH_EXPIRES_IN: "7d",
            GITHUB_OAUTH_CLIENT_ID: "test-client-id",
            GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
            TOKEN_ENCRYPTION_KEY: "test-encryption-key-32-characters!",
            CORS_ALLOWED_ORIGINS: "http://localhost:5173",
        },
    },
});