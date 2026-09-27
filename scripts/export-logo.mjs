#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const page = `${pathToFileURL(join(here, "logo.html")).href}#export`;

const dom = execFileSync(chrome, ["--headless=new", "--disable-gpu", "--dump-dom", page], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "ignore"],
});

const icons = [...dom.matchAll(/<pre data-file="([^"]+)">data:image\/png;base64,([^<]+)<\/pre>/g)];
if (icons.length === 0) throw new Error("scripts/logo.html rendered no icons");

for (const [, file, data] of icons) {
  writeFileSync(join(here, "..", "public", file), Buffer.from(data, "base64"));
  process.stdout.write(`public/${file}\n`);
}
