import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

const { DB, TEST_MIGRATIONS } = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(DB, TEST_MIGRATIONS);
