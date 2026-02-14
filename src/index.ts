import "dotenv/config";
import Fastify from "fastify";
import { registerErrorHandler } from "./common/error-handler.js";
import { env } from "./config/env.js";
import { closeDbPool, getDbPool } from "./lib/db.js";
import { registerSampleItemRoutes } from "./modules/sample-item/sample-item.route.js";
import {
  InMemorySampleItemRepository,
  PgSampleItemRepository,
  initializeSampleItemTable,
} from "./modules/sample-item/sample-item.repository.js";

const app = Fastify({
  logger: env.NODE_ENV !== "test",
});

registerErrorHandler(app);

const dbPool = getDbPool();
if (dbPool) {
  await initializeSampleItemTable(dbPool);
}

const sampleItemRepository = dbPool
  ? new PgSampleItemRepository(dbPool)
  : new InMemorySampleItemRepository();

app.get("/health", async () => {
  return {
    ok: true,
    service: "qode-server",
    storage: dbPool ? "postgres" : "memory",
    now: new Date().toISOString(),
  };
});

await registerSampleItemRoutes(app, { repository: sampleItemRepository });

app.addHook("onClose", async () => {
  await closeDbPool();
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
