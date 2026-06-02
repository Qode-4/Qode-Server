import { config } from "dotenv";

config({ path: ".env", override: true });

if (process.env.NODE_ENV !== "production") {
  config({ path: ".env.local", override: true });
}
