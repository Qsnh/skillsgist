import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, getVersion } from "../src/db/queries";
import {
  appFetch, bearer, env, GOOD_MD, installKey, ORIGIN, OTHER_MD, postForm, publishMarkdown, resetDb, seedAndLogin,
  seedProject, seedWithSkills, signInDevice, storage,
} from "./helpers";
import type { AppRequestInit } from "./helpers";

const send = (path: string, init: AppRequestInit = {}) => appFetch(`${ORIGIN}${path}`, init);

async function artifactPath(indexPath: string, slug: string, init: AppRequestInit = {}): Promise<string> {
  const index = (await (await send(indexPath, init)).json()) as { skills: Array<{ name: string; url: string }> };
  const entry = index.skills.find((s) => s.name === slug);
  if (!entry) throw new Error(`${slug} is not in ${indexPath}`);
  return new URL(entry.url).pathname;
}

interface LogRow {
  source: string;
  user_id: string | null;
  username: string | null;
  device_name: string | null;
  country: string | null;
  version: number;
}

interface ClientRow {
  ip: string | null;
  user_agent: string | null;
}

const logs = () =>
  env.db
    .prepare("SELECT source, user_id, username, device_name, country, version FROM download_logs ORDER BY id")
    .all() as LogRow[];

const clients = () => env.db.prepare("SELECT ip, user_agent FROM download_logs ORDER BY id").all() as ClientRow[];

describe("recording downloads", () => {
  beforeEach(resetDb);

  it("records a signed-in browser download as web, with the account and the version", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    await publishMarkdown(cookie, `${GOOD_MD}\nv2\n`, "private");
    expect((await send("/p/default/s/demo-skill/v/1/download", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await send("/p/default/s/demo-skill/download", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(logs()).toEqual([
      { source: "web", user_id: user.id, username: "alice", device_name: null, country: null, version: 1 },
      { source: "web", user_id: user.id, username: "alice", device_name: null, country: null, version: 2 },
    ]);
  });

  it("records an anonymous browser download of a public skill", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    expect((await send("/p/default/s/demo-skill/download")).status).toBe(200);
    expect(logs()).toEqual([
      { source: "anonymous", user_id: null, username: null, device_name: null, country: null, version: 1 },
    ]);
  });

  it("records a CLI sign-in with its computer, and an install key with the member it belongs to", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const device = await signInDevice(user.id, ["default"], Date.now(), "work-laptop");
    const key = await installKey(user.id);
    const path = await artifactPath("/p/default/.well-known/agent-skills/index.json", "other-skill", { headers: bearer(key) });
    expect((await send(path, { headers: bearer(device.token) })).status).toBe(200);
    expect((await send(path, { headers: bearer(key) })).status).toBe(200);
    expect(logs()).toEqual([
      { source: "device", user_id: user.id, username: "alice", device_name: "work-laptop", country: null, version: 1 },
      { source: "install_key", user_id: user.id, username: "alice", device_name: null, country: null, version: 1 },
    ]);
  });

  it("names the downloader on the root address when the credential works, and never refuses one that does not", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const device = await signInDevice(user.id, ["default"]);
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");
    expect(path.startsWith("/d/demo-skill/")).toBe(true);
    expect((await send(path, { headers: bearer(device.token) })).status).toBe(200);
    expect((await send(path, { headers: bearer(`sgd_${"0".repeat(64)}`) })).status).toBe(200);
    expect((await send(path, { headers: bearer("not-a-token") })).status).toBe(200);
    expect(logs().map((l) => [l.source, l.username])).toEqual([
      ["device", "alice"],
      ["anonymous", null],
      ["anonymous", null],
    ]);
  });

  it("puts a root download on the oldest of two public skills that share the name and the archive", async () => {
    seedProject("team-b", "Team B");
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [GOOD_MD, "public", "team-b"]);
    const digest = getVersion(env.db, "default", "demo-skill", 1)!.digest;
    env.db
      .prepare("UPDATE versions SET digest = ? WHERE skill_id = (SELECT id FROM skills WHERE project = 'team-b')")
      .run(digest);
    env.db.prepare("UPDATE skills SET created_at = 0 WHERE project = 'team-b'").run();
    expect((await send(`/d/demo-skill/${digest.slice("sha256:".length)}.zip`)).status).toBe(200);
    expect(env.db.prepare("SELECT s.project FROM download_logs l JOIN skills s ON s.id = l.skill_id").all()).toEqual([
      { project: "team-b" },
    ]);
  });

  it("stores the country GeoIP finds for the client IP address, and none for an address it does not know", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    for (const clientIp of ["203.0.113.7", "198.51.100.20", "2001:db8:1::5", "192.0.2.1"]) {
      expect((await send("/p/default/s/demo-skill/download", { clientIp })).status).toBe(200);
    }
    expect(logs().map((l) => l.country)).toEqual(["NZ", "DE", "JP", null]);
  });

  it("stores the client IP address and the User-Agent the request sent", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const device = await signInDevice(user.id, ["default"]);
    const path = await artifactPath("/p/default/.well-known/agent-skills/index.json", "demo-skill");
    await send("/p/default/s/demo-skill/download", { headers: { "User-Agent": "Mozilla/5.0" }, clientIp: "203.0.113.7" });
    await send(path, { headers: { ...bearer(device.token), "User-Agent": "node" }, clientIp: "2001:db8::1" });
    await send("/p/default/s/demo-skill/download");
    expect(clients()).toEqual([
      { ip: "203.0.113.7", user_agent: "Mozilla/5.0" },
      { ip: "2001:db8::1", user_agent: "node" },
      { ip: null, user_agent: null },
    ]);
  });

  it("keeps the first 512 characters of a longer User-Agent", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await send("/p/default/s/demo-skill/download", { headers: { "User-Agent": `${"a".repeat(512)}tail` } });
    expect(clients()[0].user_agent).toBe("a".repeat(512));
  });

  it("records nothing for HEAD, refused requests or a missing archive", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const pub = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");
    const hex = getVersion(env.db, "default", "other-skill", 1)!.digest.slice("sha256:".length);
    expect((await send(pub, { method: "HEAD" })).status).toBe(200);
    expect((await send("/p/default/s/other-skill/download")).status).toBe(404);
    expect((await send(`/p/default/d/other-skill/${hex}.zip`, { headers: bearer(`sgi_${"0".repeat(64)}`) })).status).toBe(401);
    await storage.delete(getVersion(env.db, "default", "demo-skill", 1)!.object_key);
    expect((await send(pub)).status).toBe(404);
    expect(logs()).toEqual([]);
  });

  it("serves the archive and counts nothing when the log write fails", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    env.db.exec("CREATE TRIGGER reject_log_write BEFORE INSERT ON download_logs BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await send("/p/default/s/demo-skill/download");
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(error).toHaveBeenCalledWith("download record write failed", expect.anything());
    } finally {
      error.mockRestore();
      env.db.exec("DROP TRIGGER reject_log_write");
    }
    expect(getSkill(env.db, "default", "demo-skill")?.download_count).toBe(0);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM download_days").pluck().get()).toBe(0);
    expect(logs()).toEqual([]);
  });

  it("moves a skill's downloads with it, deletes them with it, and keeps them when the account goes", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    seedProject("team-b", "Team B");
    const alice = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"], [OTHER_MD, "private"]);
    await send("/p/default/s/demo-skill/download", { headers: { Cookie: alice.cookie } });
    await send("/p/default/s/other-skill/download", { headers: { Cookie: alice.cookie } });

    expect((await postForm("/p/default/s/demo-skill/move", root.cookie, { project: "team-b" })).status).toBe(302);
    const moved = env.db
      .prepare("SELECT COUNT(*) AS n FROM download_logs l JOIN skills s ON s.id = l.skill_id WHERE s.project = 'team-b'")
      .pluck()
      .get();
    expect(moved).toBe(1);

    const otherId = getSkill(env.db, "default", "other-skill")!.id;
    const dailyCounts = () =>
      ["download_days", "download_user_days"].map((table) =>
        env.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE skill_id = ?`).pluck().get(otherId),
      );
    expect(dailyCounts()).toEqual([1, 1]);
    expect((await postForm("/p/default/s/other-skill/delete", root.cookie)).status).toBe(302);
    expect(logs()).toHaveLength(1);
    expect(dailyCounts()).toEqual([0, 0]);

    expect((await postForm(`/admin/users/${alice.user.id}/delete`, root.cookie)).status).toBe(302);
    expect(logs()).toEqual([
      { source: "web", user_id: alice.user.id, username: "alice", device_name: null, country: null, version: 1 },
    ]);
  });
});
