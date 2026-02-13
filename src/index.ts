import "dotenv/config";
import Fastify from "fastify";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
});

const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set in production");
}

const app = Fastify({
  logger: env.NODE_ENV !== "test",
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "qode-server",
    now: new Date().toISOString(),
  };
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
