#!/usr/bin/env node
// 用真实的 `npx skills` 验证 registry 协议兼容性。
// 起一个本地 wrangler dev，发布一个 skill，然后让 CLI 装它，最后检查文件是否落地。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 8788;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = "verify-cli-password";
// wrangler dev has no way to read `.dev.vars` we don't control and this repo
// ships none (Tasks 1-12 never ran a real `wrangler dev`, only the sandboxed
// vitest-pool-workers runtime, which injects SESSION_SECRET as a Miniflare
// binding). Without it, `c.env.SESSION_SECRET` is undefined and every route
// that touches a session cookie 500s. `--var` injects it for just this
// process without requiring any file on disk.
const SESSION_SECRET = randomBytes(32).toString("hex");

function log(msg) {
  process.stdout.write(`[verify-cli] ${msg}\n`);
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev 未在超时时间内就绪");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    child.on("error", reject);
  });
}

function findFile(root, relative) {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (full.endsWith(relative)) return full;
    }
  }
  return null;
}

// Kills the whole `wrangler dev` process tree and waits for it to actually
// exit, so a second run of this script never fights the previous one for
// PORT. SIGTERM cascades to wrangler's workerd children on its own (verified
// empirically); SIGKILL is only a backstop if it doesn't.
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  if (timedOut) {
    server.kill("SIGKILL");
    await exited;
  }
}

const server = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--var", `SESSION_SECRET:${SESSION_SECRET}`],
  { stdio: ["ignore", "inherit", "inherit"] },
);

let exitCode = 1;
try {
  await waitForServer();
  log("wrangler dev 已就绪");

  // 1. 建管理员并登录
  const setup = await fetch(`${ORIGIN}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  if (setup.status !== 302 && setup.status !== 404) {
    throw new Error(`/setup 返回了 ${setup.status}`);
  }

  const loginRes = await fetch(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("登录未返回会话 cookie");
  log("已登录");

  // 2. 取 api token 与 install key
  const tokenHtml = await (
    await fetch(`${ORIGIN}/me/api-token`, { method: "POST", headers: { Cookie: cookie } })
  ).text();
  const token = /sgt_[a-f0-9]{32}/.exec(tokenHtml)?.[0];
  if (!token) throw new Error("未能生成 api token");

  const meHtml = await (await fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
  const installKey = /\/i\/([a-f0-9]{32})/.exec(meHtml)?.[1];
  if (!installKey) throw new Error("未能读取 install key");
  log(`install key: ${installKey.slice(0, 8)}…`);

  // 3. 发布一个私有 skill（wrapped.zip：SKILL.md 包在 demo-skill/ 目录下，
  // 顺带验证去外层包装目录的路径）
  const fixture = readFileSync(new URL("../test/fixtures/wrapped.zip", import.meta.url));
  const publish = await fetch(`${ORIGIN}/api/skills/demo-skill`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
    body: fixture,
  });
  if (publish.status !== 201 && publish.status !== 200) {
    throw new Error(`发布失败：${publish.status} ${await publish.text()}`);
  }
  log("已发布 demo-skill");

  // 3b. 同一个 skill 再用一个 macOS `tar czf` 产出的、块对齐补零的 tar.gz 重新
  // 发布一次。内容和 wrapped.zip 解包后完全一样，所以大概率落在 unchanged
  // (200) 分支，但这走的是真实 HTTP 请求 + workerd 运行时，而不是 vitest 沙箱，
  // 用来确认这条"容忍 bsdtar 尾部填充"的路径在真实部署形态下也是通的。
  const bsdtarFixture = readFileSync(new URL("../test/fixtures/bsdtar-padded.tar.gz", import.meta.url));
  const publish2 = await fetch(`${ORIGIN}/api/skills/demo-skill`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip" },
    body: bsdtarFixture,
  });
  if (publish2.status !== 201 && publish2.status !== 200) {
    throw new Error(`bsdtar-padded.tar.gz 发布失败：${publish2.status} ${await publish2.text()}`);
  }
  log(`bsdtar-padded.tar.gz 发布通过（${publish2.status}）`);

  // 4. 校验 index 中的 digest 与产物字节一致
  const index = await (
    await fetch(`${ORIGIN}/i/${installKey}/.well-known/agent-skills/index.json`)
  ).json();
  const entry = index.skills.find((s) => s.name === "demo-skill");
  if (!entry) throw new Error("index 中找不到 demo-skill");
  const artifact = new Uint8Array(await (await fetch(entry.url)).arrayBuffer());
  const hash = await crypto.subtle.digest("SHA-256", artifact);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (`sha256:${hex}` !== entry.digest) throw new Error("产物 digest 与 index 不一致");
  log("digest 校验通过");

  // 5. 用真实的 npx skills 安装到一个隔离的 HOME，避免污染本机 skills 目录
  const home = mkdtempSync(join(tmpdir(), "skillsgist-verify-"));
  await run(
    "npx",
    ["--yes", "skills", "add", `${ORIGIN}/i/${installKey}`, "-g", "-y", "-s", "demo-skill", "--copy"],
    { env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") } },
  );

  const installed = findFile(home, join("demo-skill", "SKILL.md"));
  if (!installed) throw new Error(`npx skills 未把 demo-skill 装到 ${home}`);
  const content = readFileSync(installed, "utf8");
  if (!content.includes("name: demo-skill")) throw new Error("装上的 SKILL.md 内容不对");
  // SKILL.md 之外的文件也应该一起落地 —— 证明装的是完整 skill 目录，不只是
  // 恰好出现了一个同名文件。
  if (!findFile(home, join("demo-skill", "references", "api.md"))) {
    throw new Error("装上的 skill 缺少 references/api.md，安装不完整");
  }
  if (!findFile(home, join("demo-skill", "scripts", "run.sh"))) {
    throw new Error("装上的 skill 缺少 scripts/run.sh，安装不完整");
  }
  log(`安装成功：${installed}`);

  // 6. 单个 skill 的安装路径也要能用
  const home2 = mkdtempSync(join(tmpdir(), "skillsgist-verify-single-"));
  await run(
    "npx",
    ["--yes", "skills", "add", `${ORIGIN}/i/${installKey}/.well-known/agent-skills/demo-skill`, "-g", "-y", "--copy"],
    { env: { ...process.env, HOME: home2, USERPROFILE: home2, XDG_CONFIG_HOME: join(home2, ".config") } },
  );
  if (!findFile(home2, join("demo-skill", "SKILL.md"))) {
    throw new Error("单 skill 安装路径不生效");
  }
  log("单 skill 安装路径通过");

  log("全部契约检查通过");
  exitCode = 0;
} catch (err) {
  process.stderr.write(`[verify-cli] 失败：${err.message}\n`);
} finally {
  await stopServer(server);
}

process.exit(exitCode);
