import { config } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loads the repository-root .env (one level above bot/), then bot/.env if present.
 * Existing environment variables are never overwritten.
 */
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
const botEnv = fileURLToPath(new URL("../../.env", import.meta.url));
for (const path of [rootEnv, botEnv]) if (existsSync(path)) config({ path, quiet: true });
