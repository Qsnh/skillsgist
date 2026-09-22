import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workers running inside the pool get a sandboxed, empty `node:fs` virtual
// filesystem with no bridge to the host disk (verified empirically: even
// `process.cwd()` and `/tmp` are unreachable from inside a test). Binary test
// fixtures therefore have to be read from the real filesystem here, in the
// config file — which runs in plain Node, same as `readD1Migrations` below —
// and handed into the worker as `dataBlobBindings`, which surface inside
// tests as `env.<NAME>: ArrayBuffer`.
const fixture = (name: string) => new Uint8Array(readFileSync(`./test/fixtures/${name}`));

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, SESSION_SECRET: "test-secret" },
          dataBlobBindings: {
            FLAT_ZIP: fixture("flat.zip"),
            WRAPPED_ZIP: fixture("wrapped.zip"),
            FLAT_DOT_TAR_GZ: fixture("flat-dot.tar.gz"),
            SYMLINK_TAR_GZ: fixture("symlink.tar.gz"),
            BSDTAR_PADDED_TAR_GZ: fixture("bsdtar-padded.tar.gz"),
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
