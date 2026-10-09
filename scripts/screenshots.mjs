#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8799;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://skills.example.com";
const PASSWORD = "screenshots-password";
const RELEASE_NOTES = join(root, "scripts", "screenshot-skills", "release-notes");
const SKILLS = [
  ["onboarding-checklist", "public", "Walk a new teammate through repository setup, local tooling and the first pull request."],
  ["sql-migration-guard", "private", "Check a SQL migration for locking, data loss and rollback risks before it runs against production."],
  ["pr-review", "public", "Review a pull request against the team checklist for correctness, tests, security and naming before approving."],
];
const SHOTS = [
  { path: "/", width: 1280, height: 900, out: "docs/images/home.png" },
];

const work = mkdtempSync(join(tmpdir(), "skillsgist-screenshots-"));
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

function form(path, fields, cookie) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function publish(token, name, visibility, contentType, body) {
  const res = await fetch(`${BASE}/api/projects/default/skills/${name}?visibility=${visibility}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body,
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`publish ${name}: ${res.status} ${await res.text()}`);
  await sleep(1100);
}

async function seed() {
  await form("/setup", { username: "maya", password: PASSWORD });
  const login = await form("/login", { username: "maya", password: PASSWORD });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await (await fetch(`${BASE}/me`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="_csrf" value="([a-f0-9]{32})"/.exec(me)?.[1];
  const token = /sgt_[a-f0-9]{32}/.exec(await (await form("/me/api-token", { _csrf: csrf }, cookie)).text())?.[0];
  if (!token) throw new Error("no API token; did setup or sign-in fail?");
  for (const [name, visibility, description] of SKILLS) {
    await publish(token, name, visibility, "text/markdown", `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  }
  const skillMd = readFileSync(join(RELEASE_NOTES, "SKILL.fixture.md"), "utf8");
  await publish(token, "release-notes", "public", "text/markdown", skillMd.replace("in under a minute", "quickly"));
  const skillDir = join(work, "release-notes");
  cpSync(RELEASE_NOTES, skillDir, { recursive: true });
  renameSync(join(skillDir, "SKILL.fixture.md"), join(skillDir, "SKILL.md"));
  const zip = join(work, "release-notes.zip");
  execFileSync("zip", ["-qr", zip, "."], { cwd: skillDir });
  await publish(token, "release-notes", "public", "application/zip", readFileSync(zip));
  return cookie;
}

function devtools(ws) {
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
    } else if (msg.method) {
      for (const waiter of waiters.filter((w) => w.method === msg.method)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  return {
    send(method, params = {}) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params }));
      return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
    },
    once(method) {
      return new Promise((resolve) => waiters.push({ method, resolve }));
    },
  };
}

async function capture(cookie) {
  children.push(
    spawn(chrome, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(work, "chrome")}`, "--hide-scrollbars", "about:blank"], {
      stdio: "ignore",
    }),
  );
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  const page = devtools(ws);
  await page.send("Page.enable");
  await page.send("Network.enable");
  const [name, ...value] = cookie.split("=");
  await page.send("Network.setCookie", { name, value: value.join("="), url: BASE });
  for (const shot of SHOTS) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: false });
    const loaded = page.once("Page.loadEventFired");
    await page.send("Page.navigate", { url: `${BASE}${shot.path}` });
    await loaded;
    await page.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
    await sleep(1500);
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(root, shot.out), Buffer.from(data, "base64"));
    process.stdout.write(`${shot.out}\n`);
  }
  ws.close();
}

try {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  const state = join(work, "state");
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], { cwd: root, stdio: "ignore" });
  children.push(
    spawn(
      "npx",
      [
        "wrangler", "dev", "--port", String(PORT), "--persist-to", state,
        "--local-upstream", "skills.example.com", "--upstream-protocol", "https",
        "--var", `SESSION_SECRET:${randomBytes(32).toString("hex")}`,
      ],
      { cwd: root, stdio: "ignore" },
    ),
  );
  await waitFor(`${BASE}/healthz`);
  await capture(await seed());
} finally {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", resolve);
          child.kill("SIGTERM");
        }),
    ),
  );
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
