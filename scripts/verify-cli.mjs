#!/usr/bin/env node
// Verify the registry against the skillsgist CLI (and the stock `npx skills` for public skills).
// Start a local wrangler dev, publish a skill, have the CLI install it, then check the files landed.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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

const seenSecrets = new Set();

function remember(secret) {
  if (secret) seenSecrets.add(secret);
  return secret;
}

function redact(text) {
  let result = text;
  for (const secret of seenSecrets) result = result.split(secret).join(`${secret.slice(0, 8)}…`);
  return result.replace(/sg[dit]_[a-f0-9]+/g, (match) => (match.length > 8 ? `${match.slice(0, 8)}…` : match));
}

function log(msg) {
  process.stdout.write(`[verify-cli] ${redact(msg)}\n`);
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
  throw new Error("wrangler dev was not ready before the timeout");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    child.on("error", reject);
  });
}

const temps = [];

function tempDir(prefix = "skillsgist-verify-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function isolatedEnv(home, extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SystemRoot|ComSpec|TMPDIR|TEMP|TMP|LANG|LC_\w+|NODE_EXTRA_CA_CERTS|https?_proxy|no_proxy|npm_config_registry|DISABLE_TELEMETRY|DO_NOT_TRACK)$/i.test(name),
    ),
  );
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), ...extra };
}

function scriptArgs() {
  if (process.platform === "darwin" || process.platform === "freebsd") return (command) => ["-q", "/dev/null", "sh", "-c", command];
  const version = spawnSync("script", ["--version"], { encoding: "utf8" });
  if (/util-linux/.test(version.stdout ?? "")) return (command) => ["-qec", command, "/dev/null"];
  return null;
}

const terminalArgs = scriptArgs();

function inTerminal(command, opts = {}) {
  const sized = `stty cols 200 rows 50 2>/dev/null; ${command}`;
  return new Promise((resolve, reject) => {
    const child = spawn("script", terminalArgs(sized), { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd, env: opts.env });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (out += chunk));
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 180_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
      if (code === 0) resolve(text);
      else reject(new Error(`\`${command}\` ${signal ? "never finished and was killed" : `exited with code ${code}`}:\n${text}`));
    });
  });
}

const CLI = (process.env.SKILLSGIST_CLI ?? "npx --yes skillsgist@latest")
  .split(" ")
  .map((part) => (part.includes("/") ? resolve(part) : part));

const DEFAULT_CLI_TIMEOUT_MS = 180_000;

const children = new Set();

function cli(args, env, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI[0], [...CLI.slice(1), ...args], { env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let out = "";
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        out += chunk;
        opts.onOutput?.(out);
      });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, out: timedOut ? `${out}\ntimed out after ${timeoutMs}ms and was killed` : out });
    });
  });
}

async function installTo(url, extraArgs = [], env = {}, home = tempDir()) {
  const { code, out } = await cli(["add", url, "-g", "-y", "--copy", ...extraArgs], isolatedEnv(home, env));
  if (code !== 0) throw new Error(`skillsgist add ${url} exited with ${code}:\n${out}`);
  return home;
}

function filesContaining(root, secret) {
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (readFileSync(full).includes(secret)) hits.push(full);
    }
  }
  return hits;
}

/** The skill directory name installed under this HOME (taken from the directory holding SKILL.md). */
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

/** Assert an install produced exactly `expected` — no more, no less. */
function expectInstalled(home, expected, label) {
  const actual = [...installedSkillNames(home)].sort();
  if (actual.length !== expected.length || actual.some((n, i) => n !== expected[i])) {
    throw new Error(`${label}: expected exactly [${expected.join(", ")}], got [${actual.join(", ")}]`);
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

async function killChildren() {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("close", resolve);
          child.kill("SIGKILL");
        }),
    ),
  );
}

if (!terminalArgs) {
  process.stderr.write(
    "[verify-cli] failed: running the agent prompt in a terminal needs `script` from util-linux (Linux) or BSD (macOS, FreeBSD), and this system has neither\n",
  );
  process.exit(1);
}

const server = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--var", `SESSION_SECRET:${SESSION_SECRET}`],
  { stdio: ["ignore", "inherit", "inherit"] },
);

let exitCode = 1;
try {
  await waitForServer();
  log("wrangler dev is ready");

  // 1. Create an admin and sign in
  //
  // Every mutating request needs an Origin: hono/csrf rejects a form POST with
  // neither Origin nor Sec-Fetch-Site, and Node's fetch sends neither on its
  // own (a browser sends both).
  const setup = await fetch(`${ORIGIN}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  if (setup.status !== 302 && setup.status !== 404) {
    throw new Error(`/setup returned ${setup.status}`);
  }

  const loginRes = await fetch(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("login returned no session cookie");
  log("signed in");

  // 2. Fetch the api token and install key
  //
  // /me/api-token is a session-authenticated mutating route, so besides Origin
  // it needs the session-bound CSRF token, which is rendered into a hidden
  // field on the /me page.
  const meHtml = await (await fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="_csrf" value="([a-f0-9]{32})"/.exec(meHtml)?.[1];
  if (!csrf) throw new Error("could not read the CSRF token");

  const postPage = (path, fields) =>
    fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN },
      body: new URLSearchParams({ ...fields, _csrf: csrf }),
      redirect: "manual",
    });

  const tokenHtml = await (await postPage("/me/api-token", {})).text();
  const token = remember(/sgt_[a-f0-9]{32}/.exec(tokenHtml)?.[0]);
  if (!token) throw new Error("could not generate an api token");

  const projectKey = async (project) => {
    const html = await (await fetch(`${ORIGIN}/p/${project}/settings`, { headers: { Cookie: cookie } })).text();
    const key = remember(/sgi_[a-f0-9]{64}/.exec(html)?.[0]);
    if (!key) throw new Error(`could not read the install key for project ${project}`);
    return key;
  };

  const installKey = await projectKey("default");
  log(`install key: ${installKey}`);

  const downloadCounts = async () => {
    const html = await (await fetch(`${ORIGIN}/`, { headers: { Cookie: cookie } })).text();
    return Object.fromEntries(
      ["demo-skill", "other-skill"].map((slug) => {
        const meta = new RegExp(`href="/p/default/s/${slug}" class="cf-cell-link">Default/${slug}</a>[\\s\\S]*?<p class="cf-cell-meta">([\\s\\S]*?)</p>`).exec(html)?.[1] ?? "";
        const match = /([\d,]+) downloads?/.exec(meta);
        if (!match) throw new Error(`/ shows no download count for ${slug}`);
        return [slug, Number(match[1].replaceAll(",", ""))];
      }),
    );
  };

  const settledDownloadCounts = async () => {
    let last = await downloadCounts();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const now = await downloadCounts();
      if (JSON.stringify(now) === JSON.stringify(last)) return now;
      last = now;
    }
    return last;
  };

  const countedSince = (before, after) =>
    Object.fromEntries(Object.keys(after).map((slug) => [slug, after[slug] - before[slug]]));

  // 3. Publish a private skill (wrapped.zip: SKILL.md sits inside demo-skill/,
  // which also exercises stripping the outer wrapper directory)
  const publishFixture = async (name, contentType, query = "") => {
    const res = await fetch(`${ORIGIN}/api/projects/default/skills/demo-skill${query}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body: readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url)),
    });
    // 201 = new version, 200 = content unchanged; both count as a successful publish.
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`${name} failed to publish: ${res.status} ${await res.text()}`);
    }
    return res.status;
  };

  await publishFixture("wrapped.zip", "application/zip", "?visibility=private");
  log("published demo-skill (private)");

  // 3b. Publish the same skill again from a tar.gz produced by macOS `tar czf`,
  // block-aligned with trailing zero padding. Unpacked it is byte-identical to
  // wrapped.zip, so this almost certainly lands in the unchanged (200) branch —
  // but it goes over real HTTP against the workerd runtime rather than the
  // vitest sandbox, confirming the "tolerate bsdtar padding" path works in a
  // real deployment shape too.
  const status = await publishFixture("bsdtar-padded.tar.gz", "application/gzip");
  log(`bsdtar-padded.tar.gz published (${status})`);

  // 3c. Publish a second skill, this one public.
  //
  // Every single-install check below is only meaningful with several skills in
  // the index: the CLI auto-selects the sole entry of a single-entry index, so
  // with only one skill published, "narrow by slug" could be entirely broken and
  // still come up green — which is exactly how the bug where a per-skill address
  // installed every skill went unnoticed.
  const publishMarkdown = async (name, description, visibility, project = "default") => {
    const res = await fetch(`${ORIGIN}/api/projects/${project}/skills/${name}?visibility=${visibility}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`failed to publish ${name}: ${res.status} ${await res.text()}`);
    }
  };

  await publishMarkdown("other-skill", "A second skill, so the index has more than one.", "public");
  log("published other-skill (public)");

  const keyedIndex = await (
    await fetch(`${ORIGIN}/p/default/.well-known/agent-skills/index.json`, { headers: { Authorization: `Bearer ${installKey}` } })
  ).json();
  const entry = keyedIndex.skills.find((s) => s.name === "demo-skill");
  if (!entry) throw new Error("demo-skill is not in the index");
  const artifact = new Uint8Array(
    await (await fetch(entry.url, { headers: { Authorization: `Bearer ${installKey}` } })).arrayBuffer(),
  );
  const hash = await crypto.subtle.digest("SHA-256", artifact);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (`sha256:${hex}` !== entry.digest) throw new Error("artifact digest does not match the index");
  const anonFiltered = await (await fetch(`${ORIGIN}/p/default/.well-known/agent-skills/index.json`)).json();
  if (anonFiltered.skills.length !== 1 || anonFiltered.skills[0].name !== "other-skill") {
    throw new Error(`the unauthenticated index should list only other-skill, got: ${anonFiltered.skills.map((s) => s.name).join(", ")}`);
  }
  log("install key digest verified, unauthenticated index hides demo-skill");

  const beforeEnvInstall = await settledDownloadCounts();
  const envHome = await installTo(`${ORIGIN}/p/default`, ["-s", "demo-skill"], { SKILLSGIST_HOST: ORIGIN, SKILLSGIST_INSTALL_KEY: installKey });
  const envInstalled = findFile(envHome, join("demo-skill", "SKILL.md"));
  if (!envInstalled) throw new Error(`skillsgist add did not install demo-skill into ${envHome}`);
  if (!readFileSync(envInstalled, "utf8").includes("name: demo-skill")) throw new Error("the installed SKILL.md has the wrong content");
  if (!findFile(envHome, join("demo-skill", "references", "api.md"))) {
    throw new Error("the installed skill is missing references/api.md — incomplete install");
  }
  if (!findFile(envHome, join("demo-skill", "scripts", "run.sh"))) {
    throw new Error("the installed skill is missing scripts/run.sh — incomplete install");
  }
  expectInstalled(envHome, ["demo-skill"], "-s demo-skill with SKILLSGIST_INSTALL_KEY");
  const afterEnvInstall = await settledDownloadCounts();
  const envCounted = countedSince(beforeEnvInstall, afterEnvInstall);
  if (envCounted["demo-skill"] !== 1) {
    throw new Error(`one install of demo-skill should count one download, counted ${envCounted["demo-skill"]}`);
  }
  if (existsSync(join(envHome, ".config", "skillsgist", "credentials.json"))) {
    throw new Error("installing with SKILLSGIST_INSTALL_KEY should not write credentials.json");
  }
  const leakedKey = filesContaining(envHome, installKey);
  if (leakedKey.length > 0) throw new Error(`the install key leaked into installed files: ${leakedKey.join(", ")}`);
  log(`env install counted demo-skill +1, other-skill +${envCounted["other-skill"]}, and left no trace of the key`);

  const keyedHome = await installTo(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`, [], {
    SKILLSGIST_HOST: ORIGIN,
    SKILLSGIST_INSTALL_KEY: installKey,
  });
  expectInstalled(keyedHome, ["demo-skill"], "keyed single-skill install address");
  const keyedCounted = countedSince(afterEnvInstall, await settledDownloadCounts());
  if (keyedCounted["demo-skill"] !== 1 || keyedCounted["other-skill"] !== 0) {
    throw new Error(
      `the single-skill address should count demo-skill +1 and other-skill +0, counted +${keyedCounted["demo-skill"]} and +${keyedCounted["other-skill"]}`,
    );
  }
  log("keyed single-skill install address passed and counted exactly one download");

  const anonCliHome = await installTo(`${ORIGIN}/p/default/.well-known/agent-skills/other-skill`);
  expectInstalled(anonCliHome, ["other-skill"], "anonymous single-skill install with the skillsgist CLI");
  const stockHome = tempDir();
  await run("npx", ["--yes", "skills", "add", `${ORIGIN}/p/default/.well-known/agent-skills/other-skill`, "-g", "-y", "--copy"], {
    env: isolatedEnv(stockHome),
  });
  expectInstalled(stockHome, ["other-skill"], "anonymous single-skill install with the stock npx skills");
  log("anonymous public installs passed with both the skillsgist CLI and the stock npx skills");

  const created = await postPage("/projects/new", { name: "Verify other", slug: "verify-other" });
  if (created.status !== 302 && created.status !== 400) {
    throw new Error(`/projects/new returned ${created.status}`);
  }
  const otherHtml = await (await fetch(`${ORIGIN}/p/verify-other/settings`, { headers: { Cookie: cookie } })).text();
  const verifierId = /<option value="([a-f0-9]{16})">verifier<\/option>/.exec(otherHtml)?.[1];
  if (verifierId) {
    const joined = await postPage("/p/verify-other/members", { user: verifierId, role: "admin" });
    if (joined.status !== 302) throw new Error(`adding verifier to verify-other returned ${joined.status}`);
  }
  const otherKey = await projectKey("verify-other");
  await publishMarkdown("demo-skill", "The verify-other copy of demo-skill.", "private", "verify-other");
  log("published a second demo-skill (private) into project verify-other");

  const { code: wrongCode, out: wrongOut } = await cli(
    ["add", `${ORIGIN}/p/default`, "-g", "-y", "--copy"],
    isolatedEnv(tempDir(), { SKILLSGIST_HOST: ORIGIN, SKILLSGIST_INSTALL_KEY: otherKey }),
  );
  if (wrongCode === 0 || !wrongOut.includes("is for project verify-other")) {
    throw new Error(`installing /p/default with verify-other's key should fail naming its project, got code ${wrongCode}:\n${wrongOut}`);
  }
  const wrongProjectHome = await installTo(`${ORIGIN}/p/verify-other`, [], {
    SKILLSGIST_HOST: ORIGIN,
    SKILLSGIST_INSTALL_KEY: otherKey,
  });
  expectInstalled(wrongProjectHome, ["demo-skill"], "verify-other's install key");
  const wrongProjectInstalled = findFile(wrongProjectHome, join("demo-skill", "SKILL.md"));
  if (!wrongProjectInstalled || !readFileSync(wrongProjectInstalled, "utf8").includes("The verify-other copy of demo-skill.")) {
    throw new Error("verify-other's install key installed the wrong demo-skill");
  }
  log("project-scoped install keys passed");

  const deviceHome = tempDir();
  let codeFound = false;
  let resolveUserCode;
  const userCodeFound = new Promise((resolve) => {
    resolveUserCode = resolve;
  });
  const onLoginOutput = (out) => {
    const match = /\b([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\b/.exec(out);
    if (match) {
      codeFound = true;
      resolveUserCode(match[1]);
    }
  };
  const loginPromise = cli(["login", `${ORIGIN}/p/default`, "--no-browser"], isolatedEnv(deviceHome), { onOutput: onLoginOutput });
  const userCode = await Promise.race([
    userCodeFound,
    loginPromise.then(({ code, out }) => {
      if (!codeFound) throw new Error(`skillsgist login exited with ${code} before printing a device code:\n${out}`);
    }),
  ]);
  log(`device code: ${userCode}`);

  const confirmPage = await postPage("/device", { code: userCode });
  if (confirmPage.status !== 200) throw new Error(`POST /device with the code answered ${confirmPage.status}`);
  const approvePage = await postPage("/device", { code: userCode, decision: "approve", project: "default" });
  if (approvePage.status !== 200) throw new Error(`POST /device approve answered ${approvePage.status}`);

  const { code: loginExit, out: loginOut } = await loginPromise;
  if (loginExit !== 0 || !loginOut.includes("projects: default")) {
    throw new Error(`skillsgist login did not finish signed in to project default:\n${loginOut}`);
  }
  const credentialsPath = join(deviceHome, ".config", "skillsgist", "credentials.json");
  if (!existsSync(credentialsPath)) throw new Error(`login did not write ${credentialsPath}`);
  const credentialsMode = statSync(credentialsPath).mode & 0o777;
  if (credentialsMode !== 0o600) throw new Error(`credentials.json should be mode 0600, got ${credentialsMode.toString(8)}`);
  log("device sign-in approved and finished");

  await installTo(`${ORIGIN}/p/default`, ["-s", "demo-skill"], {}, deviceHome);
  expectInstalled(deviceHome, ["demo-skill"], "device sign-in install");
  log("device sign-in installed the private skill without SKILLSGIST_INSTALL_KEY");

  const savedCredentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const deviceToken = remember(savedCredentials.hosts?.[ORIGIN]?.token);
  if (!deviceToken) throw new Error("could not read the device token from credentials.json");
  const { code: logoutCode, out: logoutOut } = await cli(["logout"], isolatedEnv(deviceHome));
  if (logoutCode !== 0) throw new Error(`skillsgist logout exited with ${logoutCode}:\n${logoutOut}`);
  const revokedWhoami = await fetch(`${ORIGIN}/api/whoami`, { headers: { Authorization: `Bearer ${deviceToken}` } });
  if (revokedWhoami.status !== 401) throw new Error(`a revoked device token should answer 401 from /api/whoami, got ${revokedWhoami.status}`);
  if (existsSync(credentialsPath)) throw new Error("logout did not delete credentials.json");
  log("device logout revoked the token and removed credentials.json");

  const { code: oldAddressCode, out: oldAddressOut } = await cli(["add", `${ORIGIN}/i/${"a".repeat(32)}`], isolatedEnv(tempDir()));
  if (oldAddressCode === 0 || !oldAddressOut.includes("Install keys no longer go in the URL")) {
    throw new Error(`an /i/ address should be rejected with "Install keys no longer go in the URL", got code ${oldAddressCode}:\n${oldAddressOut}`);
  }
  const staleIndex = await fetch(`${ORIGIN}/i/${"a".repeat(32)}/.well-known/agent-skills/index.json`);
  if (staleIndex.status !== 404) throw new Error(`a stale /i/ address should answer 404, got ${staleIndex.status}`);
  log("old /i/ addresses are rejected by the CLI and answer 404 from the server");

  await publishFixture("wrapped.zip", "application/zip", "?visibility=private");
  const skillPage = await (await fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: cookie } })).text();
  const shown = /`(npx [^`<]+)`/.exec(skillPage)?.[1];
  if (!shown) throw new Error("the skill page shows no agent prompt");
  const expectedPrompt = `npx -y skillsgist add ${ORIGIN}/p/default/.well-known/agent-skills/demo-skill --skill demo-skill -g -y`;
  if (shown !== expectedPrompt) throw new Error(`the agent prompt should be "${expectedPrompt}", got "${shown}"`);
  const command = shown.replace("npx -y skillsgist", CLI.join(" "));
  for (const [where, agentEnv, agentDir] of [
    ["inside Claude Code", { CLAUDECODE: "1" }, ".claude"],
    ["inside an agent the CLI does not know", {}, null],
  ]) {
    const label = `the agent prompt run ${where}`;
    const project = tempDir();
    const home = tempDir();
    const env = isolatedEnv(home, {
      ...agentEnv,
      npm_config_cache: tempDir("skillsgist-verify-npm-"),
      SKILLSGIST_HOST: ORIGIN,
      SKILLSGIST_INSTALL_KEY: installKey,
    });
    const output = await inTerminal(command, { cwd: project, env });
    const reported = /~\/\.agents\/skills\/demo-skill\b/.exec(output)?.[0];
    if (!reported) throw new Error(`${label} did not report the global directory of demo-skill:\n${output}`);
    const dir = join(home, reported.slice(2));
    if (
      !existsSync(join(dir, "SKILL.md")) ||
      !readFileSync(join(dir, "SKILL.md"), "utf8").includes("name: demo-skill") ||
      !existsSync(join(dir, "references", "api.md")) ||
      !existsSync(join(dir, "scripts", "run.sh"))
    ) {
      throw new Error(`${label} did not install demo-skill and its supporting files into ${reported}`);
    }
    expectInstalled(home, ["demo-skill"], label);
    if (agentDir && !existsSync(join(home, agentDir, "skills", "demo-skill", "SKILL.md"))) {
      throw new Error(`${label} did not install demo-skill for that agent`);
    }
    const leftovers = readdirSync(project);
    if (leftovers.length > 0) throw new Error(`${label} wrote into the project: ${leftovers.join(", ")}`);
    log(`${label} installed demo-skill into ${reported} and left the project untouched`);
  }

  log("all contract checks passed");
  exitCode = 0;
} catch (err) {
  process.stderr.write(`[verify-cli] failed: ${redact(err.message)}\n`);
} finally {
  await killChildren();
  await stopServer(server);
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

process.exit(exitCode);
