import { config } from "dotenv";

for (const path of [".env", ".env.local"]) {
  config({ path, override: true });
}
