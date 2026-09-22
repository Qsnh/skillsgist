#!/usr/bin/env node
// Verify registry protocol compatibility against the real `npx skills`.
// Start a local wrangler dev, publish a skill, have the CLI install it, then check the files landed.
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
  throw new Error("wrangler dev was not ready before the timeout");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
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

  const tokenHtml = await (
    await fetch(`${ORIGIN}/me/api-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN },
      body: new URLSearchParams({ _csrf: csrf }),
    })
  ).text();
  const token = /sgt_[a-f0-9]{32}/.exec(tokenHtml)?.[0];
  if (!token) throw new Error("could not generate an api token");

  const installKey = /\/i\/([a-f0-9]{32})/.exec(meHtml)?.[1];
  if (!installKey) throw new Error("could not read the install key");
  log(`install key: ${installKey.slice(0, 8)}…`);

  // 3. Publish a private skill (wrapped.zip: SKILL.md sits inside demo-skill/,
  // which also exercises stripping the outer wrapper directory)
  const publishFixture = async (name, contentType, query = "") => {
    const res = await fetch(`${ORIGIN}/api/skills/demo-skill${query}`, {
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

  // Pass ?visibility=private explicitly: step 7 switches demo-skill to public,
  // and without switching it back here the second run of this script would blow
  // up on the "demo-skill is still private" precondition.
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
    if (res.status !== 302) throw new Error(`failed to publish ${name}: ${res.status} ${await res.text()}`);
  };

  await publishMarkdown("other-skill", "A second skill, so the index has more than one.", "public");
  log("published other-skill (public)");

  // 4. Check the digest in the index matches the artifact bytes
  const index = await (
    await fetch(`${ORIGIN}/i/${installKey}/.well-known/agent-skills/index.json`)
  ).json();
  const entry = index.skills.find((s) => s.name === "demo-skill");
  if (!entry) throw new Error("demo-skill is not in the index");
  const artifact = new Uint8Array(await (await fetch(entry.url)).arrayBuffer());
  const hash = await crypto.subtle.digest("SHA-256", artifact);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (`sha256:${hex}` !== entry.digest) throw new Error("artifact digest does not match the index");
  log("digest verified");

  // 5. Install with the real npx skills into an isolated HOME, so the machine's own skills directory stays untouched
  const home = await installTo(`${ORIGIN}/i/${installKey}`, ["-s", "demo-skill"]);

  const installed = findFile(home, join("demo-skill", "SKILL.md"));
  if (!installed) throw new Error(`npx skills did not install demo-skill into ${home}`);
  const content = readFileSync(installed, "utf8");
  if (!content.includes("name: demo-skill")) throw new Error("the installed SKILL.md has the wrong content");
  // Files other than SKILL.md should land too — proof this installed a complete
  // skill directory, not just a file that happened to share a name.
  if (!findFile(home, join("demo-skill", "references", "api.md"))) {
    throw new Error("the installed skill is missing references/api.md — incomplete install");
  }
  if (!findFile(home, join("demo-skill", "scripts", "run.sh"))) {
    throw new Error("the installed skill is missing scripts/run.sh — incomplete install");
  }
  expectInstalled(home, ["demo-skill"], "-s demo-skill");
  log(`installed: ${installed}`);

  // 6. Keyed single-skill install address. The index holds both demo-skill and
  // other-skill at this point, so this assertion really does prove "narrow to
  // the slug in the path" works.
  const home2 = await installTo(`${ORIGIN}/i/${installKey}/.well-known/agent-skills/demo-skill`);
  expectInstalled(home2, ["demo-skill"], "keyed single-skill install address");
  log("keyed single-skill install path passed");

  // 7. The anonymous single-install address for a public skill — the one /s/:slug
  // shows a signed-out visitor. First confirm demo-skill does not appear in the
  // anonymous index while it is still private.
  const anonIndex = async () =>
    (await (await fetch(`${ORIGIN}/.well-known/agent-skills/index.json`)).json()).skills.map(
      (entry) => entry.name,
    );

  const before = await anonIndex();
  if (before.includes("demo-skill")) throw new Error("demo-skill is still private; the anonymous index must not contain it");
  if (!before.includes("other-skill")) throw new Error("the anonymous index should contain other-skill");

  // Republish the same bytes with ?visibility=public added. Unchanged content
  // takes the 200 branch, but the visibility write happens before the digest
  // check, so it still takes effect (see the Fix 1 comment in src/publish.ts).
  await publishFixture("wrapped.zip", "application/zip", "?visibility=public");
  const after = await anonIndex();
  if (!after.includes("demo-skill") || !after.includes("other-skill")) {
    throw new Error(`after switching to public the anonymous index should hold two skills, got: ${after.join(", ")}`);
  }
  log(`demo-skill switched to public, anonymous index: ${after.join(", ")}`);

  const home3 = await installTo(`${ORIGIN}/.well-known/agent-skills/demo-skill`);
  expectInstalled(home3, ["demo-skill"], "anonymous single-skill install address");
  log("anonymous single-skill install path passed");

  log("all contract checks passed");
  exitCode = 0;
} catch (err) {
  process.stderr.write(`[verify-cli] failed: ${err.message}\n`);
} finally {
  await stopServer(server);
}

process.exit(exitCode);
