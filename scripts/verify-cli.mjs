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

  const projectKey = async (project) => {
    const html = await (await fetch(`${ORIGIN}/p/${project}`, { headers: { Cookie: cookie } })).text();
    const key = /\/i\/([a-f0-9]{32})/.exec(html)?.[1];
    if (!key) throw new Error(`could not read the install key for project ${project}`);
    return key;
  };

  const postPage = (path, fields) =>
    fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN },
      body: new URLSearchParams({ ...fields, _csrf: csrf }),
      redirect: "manual",
    });

  const installKey = await projectKey("default");
  log(`install key: ${installKey.slice(0, 8)}…`);

  const downloadCounts = async () => {
    const html = await (await fetch(`${ORIGIN}/`, { headers: { Cookie: cookie } })).text();
    return Object.fromEntries(
      ["demo-skill", "other-skill"].map((slug) => {
        const meta = new RegExp(`href="/p/default/s/${slug}" class="cf-cell-link">${slug}</a>[\\s\\S]*?<p class="cf-cell-meta">([\\s\\S]*?)</p>`).exec(html)?.[1] ?? "";
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
  const beforeInstall = await settledDownloadCounts();
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

  const afterInstall = await settledDownloadCounts();
  const counted = countedSince(beforeInstall, afterInstall);
  if (counted["demo-skill"] !== 1) {
    throw new Error(`one install of demo-skill should count one download, counted ${counted["demo-skill"]}`);
  }
  log(`whole-index install with -s demo-skill counted demo-skill +1, other-skill +${counted["other-skill"]}`);

  // 6. Keyed single-skill install address. The index holds both demo-skill and
  // other-skill at this point, so this assertion really does prove "narrow to
  // the slug in the path" works.
  const home2 = await installTo(`${ORIGIN}/i/${installKey}/.well-known/agent-skills/demo-skill`);
  expectInstalled(home2, ["demo-skill"], "keyed single-skill install address");
  const countedSingle = countedSince(afterInstall, await settledDownloadCounts());
  if (countedSingle["demo-skill"] !== 1 || countedSingle["other-skill"] !== 0) {
    throw new Error(
      `the single-skill address should count demo-skill +1 and other-skill +0, counted +${countedSingle["demo-skill"]} and +${countedSingle["other-skill"]}`,
    );
  }
  log("keyed single-skill install path passed and counted exactly one download");

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

  const home3b = await installTo(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
  expectInstalled(home3b, ["demo-skill"], "project public single-skill install address");
  log("project public single-skill install path passed");

  const created = await postPage("/projects/new", { name: "Verify other", slug: "verify-other" });
  if (created.status !== 302 && created.status !== 400) {
    throw new Error(`/projects/new returned ${created.status}`);
  }
  const otherHtml = await (await fetch(`${ORIGIN}/p/verify-other`, { headers: { Cookie: cookie } })).text();
  const verifierId = /<option value="([a-f0-9]{16})">verifier<\/option>/.exec(otherHtml)?.[1];
  if (verifierId) {
    const joined = await postPage("/p/verify-other/members", { user: verifierId, role: "admin" });
    if (joined.status !== 302) throw new Error(`adding verifier to verify-other returned ${joined.status}`);
  }
  const otherKey = await projectKey("verify-other");
  await publishMarkdown("demo-skill", "The verify-other copy of demo-skill.", "private", "verify-other");
  log("published a second demo-skill (private) into project verify-other");

  const keyedSkills = async (key) =>
    (await (await fetch(`${ORIGIN}/i/${key}/.well-known/agent-skills/index.json`)).json()).skills;
  const ours = (await keyedSkills(installKey)).find((s) => s.name === "demo-skill");
  const otherSkills = await keyedSkills(otherKey);
  if (otherSkills.length !== 1 || otherSkills[0].name !== "demo-skill") {
    throw new Error(`verify-other's key should list only its demo-skill, got: ${otherSkills.map((s) => s.name).join(", ")}`);
  }
  if (!ours || ours.digest === otherSkills[0].digest) {
    throw new Error("the two projects' demo-skill should be two different skills");
  }
  const crossed = await fetch(otherSkills[0].url.replace(otherKey, installKey));
  if (crossed.status !== 404) {
    throw new Error(`the default project's key downloaded verify-other's demo-skill (${crossed.status})`);
  }

  const home4 = await installTo(`${ORIGIN}/i/${otherKey}`);
  expectInstalled(home4, ["demo-skill"], "verify-other's install key");
  const otherInstalled = findFile(home4, join("demo-skill", "SKILL.md"));
  if (!otherInstalled || !readFileSync(otherInstalled, "utf8").includes("The verify-other copy of demo-skill.")) {
    throw new Error("verify-other's install key installed the wrong demo-skill");
  }
  log("project-scoped install keys passed");

  log("all contract checks passed");
  exitCode = 0;
} catch (err) {
  process.stderr.write(`[verify-cli] failed: ${err.message}\n`);
} finally {
  await stopServer(server);
}

process.exit(exitCode);
