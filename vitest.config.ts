import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
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