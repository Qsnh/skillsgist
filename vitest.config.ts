import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const fixture = (name: string) => new Uint8Array(readFileSync(`./test/fixtures/${name}`));

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, SESSION_SECRET: "test-secret" },
          d1Databases: ["MIGRATION_DB"],
          dataBlobBindings: {
            FLAT_ZIP: fixture("flat.zip"),
            WRAPPED_ZIP: fixture("wrapped.zip"),
            FLAT_DOT_TAR_GZ: fixture("flat-dot.tar.gz"),
            SYMLINK_TAR_GZ: fixture("symlink.tar.gz"),
            BSDTAR_PADDED_TAR_GZ: fixture("bsdtar-padded.tar.gz"),
            NO_SKILL_MD_ZIP: fixture("no-skill-md.zip"),
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
