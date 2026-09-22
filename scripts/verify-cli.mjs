#!/usr/bin/env node
// 用真实的 `npx skills` 验证 registry 协议兼容性。
// 起一个本地 wrangler dev，发布一个 skill，然后让 CLI 装它，最后检查文件是否落地。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 8788;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = "verify-cli-password";
// wrangler dev reads SESSION_SECRET from `.dev.vars`, and this repo ships
// none — the test suite runs on vitest-pool-workers, which injects the secret
// as a Miniflare binding instead. Without it `c.env.SESSION_SECRET` is
// undefined and every route that touches a session cookie 500s. `--var`
// injects it for just this process without requiring any file on disk.
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

/** `npx skills add <url>` against a throwaway HOME, so the real one is untouched. */
async function installTo(url, extraArgs = []) {
  const home = mkdtempSync(join(tmpdir(), "skillsgist-verify-"));
  await run("npx", ["--yes", "skills", "add", url, "-g", "-y", "--copy", ...extraArgs], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  return home;
}

/** 装到这个 HOME 下的 skill 目录名（以 SKILL.md 所在目录为准）。 */
function installedSkillNames(root) {
  const found = new Set();
  if (!existsSync(root)) return found;
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
      else if (name === "SKILL.md") found.add(basename(dir));
    }
  }
  return found;
}

/** 断言某次安装装上的 skill 恰好是 `expected`，不多不少。 */
function expectInstalled(home, expected, label) {
  const actual = [...installedSkillNames(home)].sort();
  if (actual.length !== expected.length || actual.some((n, i) => n !== expected[i])) {
    throw new Error(`${label}：期望只装 [${expected.join(", ")}]，实际装了 [${actual.join(", ")}]`);
  }
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
  //
  // 所有变更请求都要带 Origin：hono/csrf 会拒掉既没有 Origin 也没有
  // Sec-Fetch-Site 的表单 POST，而 Node 的 fetch 两个都不会自动发（浏览器会）。
  const setup = await fetch(`${ORIGIN}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  if (setup.status !== 302 && setup.status !== 404) {
    throw new Error(`/setup 返回了 ${setup.status}`);
  }

  const loginRes = await fetch(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("登录未返回会话 cookie");
  log("已登录");

  // 2. 取 api token 与 install key
  //
  // /me/api-token 是会话鉴权的变更路由，除 Origin 外还要带上会话绑定的 CSRF
  // token；它渲染在 /me 页面的隐藏字段里。
  const meHtml = await (await fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="_csrf" value="([a-f0-9]{32})"/.exec(meHtml)?.[1];
  if (!csrf) throw new Error("未能读取 CSRF token");

  const tokenHtml = await (
    await fetch(`${ORIGIN}/me/api-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN },
      body: new URLSearchParams({ _csrf: csrf }),
    })
  ).text();
  const token = /sgt_[a-f0-9]{32}/.exec(tokenHtml)?.[0];
  if (!token) throw new Error("未能生成 api token");

  const installKey = /\/i\/([a-f0-9]{32})/.exec(meHtml)?.[1];
  if (!installKey) throw new Error("未能读取 install key");
  log(`install key: ${installKey.slice(0, 8)}…`);

  // 3. 发布一个私有 skill（wrapped.zip：SKILL.md 包在 demo-skill/ 目录下，
  // 顺带验证去外层包装目录的路径）
  const publishFixture = async (name, contentType, query = "") => {
    const res = await fetch(`${ORIGIN}/api/skills/demo-skill${query}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body: readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url)),
    });
    // 201 = 新版本，200 = 内容未变；两者都算发布成功。
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`${name} 发布失败：${res.status} ${await res.text()}`);
    }
    return res.status;
  };

  // 显式带 ?visibility=private：第 7 步会把 demo-skill 改成 public，不在这里把它
  // 改回去的话，脚本第二次跑就会从「demo-skill 还是 private」那条前置断言上炸掉。
  await publishFixture("wrapped.zip", "application/zip", "?visibility=private");
  log("已发布 demo-skill（private）");

  // 3b. 同一个 skill 再用一个 macOS `tar czf` 产出的、块对齐补零的 tar.gz 重新
  // 发布一次。内容和 wrapped.zip 解包后完全一样，所以大概率落在 unchanged
  // (200) 分支，但这走的是真实 HTTP 请求 + workerd 运行时，而不是 vitest 沙箱，
  // 用来确认这条"容忍 bsdtar 尾部填充"的路径在真实部署形态下也是通的。
  const status = await publishFixture("bsdtar-padded.tar.gz", "application/gzip");
  log(`bsdtar-padded.tar.gz 发布通过（${status}）`);

  // 3c. 再发布一个 skill，而且是 public 的。
  //
  // 下面每一处单装检查都必须在 index 里有多个 skill 时才有意义：CLI 对只含一条的
  // index 会自动选中那一条，所以只发一个 skill 的话，「按 slug 收窄」整个坏掉也
  // 照样全绿 —— per-skill 安装地址会把全部 skill 都装上的那个 bug，正是这么漏网的。
  const publishMarkdown = async (name, description, visibility) => {
    const form = new FormData();
    form.set("_csrf", csrf);
    form.set("markdown", `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
    form.set("visibility", visibility);
    const res = await fetch(`${ORIGIN}/new`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: form,
      redirect: "manual",
    });
    if (res.status !== 302) throw new Error(`发布 ${name} 失败：${res.status} ${await res.text()}`);
  };

  await publishMarkdown("other-skill", "A second skill, so the index has more than one.", "public");
  log("已发布 other-skill（public）");

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
  const home = await installTo(`${ORIGIN}/i/${installKey}`, ["-s", "demo-skill"]);

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
  expectInstalled(home, ["demo-skill"], "-s demo-skill");
  log(`安装成功：${installed}`);

  // 6. 带 install key 的单 skill 安装地址。index 里此时有 demo-skill 与
  // other-skill 两个，所以这条断言真的能证明「收窄到路径里那个 slug」生效。
  const home2 = await installTo(`${ORIGIN}/i/${installKey}/.well-known/agent-skills/demo-skill`);
  expectInstalled(home2, ["demo-skill"], "带 key 的单 skill 安装地址");
  log("带 key 的单 skill 安装路径通过");

  // 7. 公开 skill 的匿名单装地址 —— 就是 /s/:slug 给未登录访客展示的那一条。
  // 先确认 demo-skill 还是 private 时不会出现在匿名 index 里。
  const anonIndex = async () =>
    (await (await fetch(`${ORIGIN}/.well-known/agent-skills/index.json`)).json()).skills.map(
      (entry) => entry.name,
    );

  const before = await anonIndex();
  if (before.includes("demo-skill")) throw new Error("demo-skill 还是 private，匿名 index 不该包含它");
  if (!before.includes("other-skill")) throw new Error("匿名 index 里应该有 other-skill");

  // 同样的字节重发一次，只多带 ?visibility=public。内容没变会走 200 unchanged
  // 分支，但可见性的写入在 digest 判断之前，所以依然生效（见 src/publish.ts 的
  // Fix 1 注释）。
  await publishFixture("wrapped.zip", "application/zip", "?visibility=public");
  const after = await anonIndex();
  if (!after.includes("demo-skill") || !after.includes("other-skill")) {
    throw new Error(`改为 public 后匿名 index 应含两个 skill，实际：${after.join(", ")}`);
  }
  log(`demo-skill 已改为 public，匿名 index：${after.join(", ")}`);

  const home3 = await installTo(`${ORIGIN}/.well-known/agent-skills/demo-skill`);
  expectInstalled(home3, ["demo-skill"], "匿名单 skill 安装地址");
  log("匿名单 skill 安装路径通过");

  log("全部契约检查通过");
  exitCode = 0;
} catch (err) {
  process.stderr.write(`[verify-cli] 失败：${err.message}\n`);
} finally {
  await stopServer(server);
}

process.exit(exitCode);
