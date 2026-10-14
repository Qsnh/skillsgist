import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, getVersion } from "../src/db/queries";
import { app } from "../src/index";
import {
  bearer, env, GOOD_MD, installKey, ORIGIN, OTHER_MD, postForm, publishMarkdown, resetDb, seedAndLogin, seedProject,
  seedWithSkills, signInDevice,
} from "./helpers";

async function settle(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function artifactPath(indexPath: string, slug: string, init: RequestInit = {}): Promise<string> {
  const index = await (await settle(indexPath, init)).json<{ skills: Array<{ name: string; url: string }> }>();
  const entry = index.skills.find((s) => s.name === slug);
  if (!entry) throw new Error(`${slug} is not in ${indexPath}`);
  return new URL(entry.url).pathname;
}

const logs = async () =>
  (
    await env.DB.prepare(
      "SELECT source, user_id, username, device_name, country, version FROM download_logs ORDER BY id",
    ).all<{ source: string; user_id: string | null; username: string | null; device_name: string | null; country: string | null; version: number }>()
  ).results;

describe("recording downloads", () => {
  beforeEach(resetDb);

  it("records a signed-in browser download as web, with the account and the version", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    await publishMarkdown(cookie, `${GOOD_MD}\nv2\n`, "private");
    expect((await settle("/p/default/s/demo-skill/v/1/download", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await settle("/p/default/s/demo-skill/download", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await logs()).toEqual([
      { source: "web", user_id: user.id, username: "alice", device_name: null, country: null, version: 1 },
      { source: "web", user_id: user.id, username: "alice", device_name: null, country: null, version: 2 },
    ]);
  });

  it("records an anonymous browser download of a public skill", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    expect((await settle("/p/default/s/demo-skill/download")).status).toBe(200);
    expect(await logs()).toEqual([
      { source: "anonymous", user_id: null, username: null, device_name: null, country: null, version: 1 },
    ]);
  });

  it("records a CLI sign-in with its computer, and an install key with the member it belongs to", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const device = await signInDevice(user.id, ["default"], Date.now(), "work-laptop");
    const key = await installKey(user.id);
    const path = await artifactPath("/p/default/.well-known/agent-skills/index.json", "other-skill", { headers: bearer(key) });
    expect((await settle(path, { headers: bearer(device.token) })).status).toBe(200);
    expect((await settle(path, { headers: bearer(key) })).status).toBe(200);
    expect(await logs()).toEqual([
      { source: "device", user_id: user.id, username: "alice", device_name: "work-laptop", country: null, version: 1 },
      { source: "install_key", user_id: user.id, username: "alice", device_name: null, country: null, version: 1 },
    ]);
  });

  it("names the downloader on the root address when the credential works, and never refuses one that does not", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const device = await signInDevice(user.id, ["default"]);
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");
    expect(path.startsWith("/d/demo-skill/")).toBe(true);
    expect((await settle(path, { headers: bearer(device.token) })).status).toBe(200);
    expect((await settle(path, { headers: bearer(`sgd_${"0".repeat(64)}`) })).status).toBe(200);
    expect((await settle(path, { headers: bearer("not-a-token") })).status).toBe(200);
    expect((await logs()).map((l) => [l.source, l.username])).toEqual([
      ["device", "alice"],
      ["anonymous", null],
      ["anonymous", null],
    ]);
  });

  it("puts a root download on the oldest of two public skills that share the name and the archive", async () => {
    await seedProject("team-b", "Team B");
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [GOOD_MD, "public", "team-b"]);
    const digest = (await getVersion(env.DB, "default", "demo-skill", 1))!.digest;
    await env.DB.batch([
      env.DB.prepare("UPDATE versions SET digest = ? WHERE skill_id = (SELECT id FROM skills WHERE project = 'team-b')").bind(digest),
      env.DB.prepare("UPDATE skills SET created_at = 0 WHERE project = 'team-b'"),
    ]);
    expect((await settle(`/d/demo-skill/${digest.slice("sha256:".length)}.zip`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT s.project FROM download_logs l JOIN skills s ON s.id = l.skill_id").all()).toMatchObject({
      results: [{ project: "team-b" }],
    });
  });

  it("stores the country Cloudflare reports for the request", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await settle("/p/default/s/demo-skill/download", { cf: { country: "DE" } } as RequestInit);
    expect((await logs())[0].country).toBe("DE");
  });

  it("records nothing for HEAD, refused requests or a missing archive", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const pub = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");
    const hex = (await getVersion(env.DB, "default", "other-skill", 1))!.digest.slice("sha256:".length);
    expect((await settle(pub, { method: "HEAD" })).status).toBe(200);
    expect((await settle("/p/default/s/other-skill/download")).status).toBe(404);
    expect((await settle(`/p/default/d/other-skill/${hex}.zip`, { headers: bearer(`sgi_${"0".repeat(64)}`) })).status).toBe(401);
    await env.BUCKET.delete((await getVersion(env.DB, "default", "demo-skill", 1))!.r2_key);
    expect((await settle(pub)).status).toBe(404);
    expect(await logs()).toEqual([]);
  });

  it("serves the archive and writes neither the count nor the log when the log write fails", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await env.DB.prepare(
      "CREATE TRIGGER reject_log_write BEFORE INSERT ON download_logs BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    ).run();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await settle("/p/default/s/demo-skill/download");
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(error).toHaveBeenCalledWith("download record write failed", expect.anything());
    } finally {
      error.mockRestore();
      await env.DB.prepare("DROP TRIGGER reject_log_write").run();
    }
    expect((await getSkill(env.DB, "default", "demo-skill"))?.download_count).toBe(0);
    expect(await logs()).toEqual([]);
  });

  it("moves a skill's downloads with it, deletes them with it, and keeps them when the account goes", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    await seedProject("team-b", "Team B");
    const alice = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"], [OTHER_MD, "private"]);
    await settle("/p/default/s/demo-skill/download", { headers: { Cookie: alice.cookie } });
    await settle("/p/default/s/other-skill/download", { headers: { Cookie: alice.cookie } });

    expect((await postForm("/p/default/s/demo-skill/move", root.cookie, { project: "team-b" })).status).toBe(302);
    const moved = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM download_logs l JOIN skills s ON s.id = l.skill_id WHERE s.project = 'team-b'",
    ).first("n");
    expect(moved).toBe(1);

    expect((await postForm("/p/default/s/other-skill/delete", root.cookie)).status).toBe(302);
    expect(await logs()).toHaveLength(1);

    expect((await postForm(`/admin/users/${alice.user.id}/delete`, root.cookie)).status).toBe(302);
    expect(await logs()).toEqual([
      { source: "web", user_id: alice.user.id, username: "alice", device_name: null, country: null, version: 1 },
    ]);
  });
});
