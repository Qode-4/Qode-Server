import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { env } from "../config/env.js";

let pool: Pool | null = null;

export const getDbPool = (): Pool | null => {
  if (!env.DATABASE_URL) {
    return null;
  }

  if (!pool) {
    const parsedUrl = new URL(env.DATABASE_URL);
    // Prevent pg connection string SSL params from overriding app-level SSL policy.
    parsedUrl.searchParams.delete("sslmode");
    parsedUrl.searchParams.delete("sslcert");
    parsedUrl.searchParams.delete("sslkey");
    parsedUrl.searchParams.delete("sslrootcert");

    const ca =
      env.DATABASE_SSL_CA_PATH !== undefined
        ? readFileSync(resolve(env.DATABASE_SSL_CA_PATH), "utf8")
        : undefined;

    const sslConfig =
      env.DATABASE_SSL_MODE === "disable"
        ? false
        : {
            rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
            ca,
          };

    pool = new Pool({
      connectionString: parsedUrl.toString(),
      ssl: sslConfig,
    });
  }

  return pool;
};

export const closeDbPool = async (): Promise<void> => {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
};
