import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, getVersion } from "../src/db/queries";
import {
  appFetch, bearer, env, GOOD_MD, installKey, joinProject, ORIGIN, OTHER_MD, resetDb, seedProject, seedWithSkills,
  storage,
} from "./helpers";
import type { AppRequestInit } from "./helpers";

const send = (path: string, init: AppRequestInit = {}) => appFetch(`${ORIGIN}${path}`, init);

async function artifactPath(indexPath: string, slug: string, init: AppRequestInit = {}): Promise<string> {
  const index = (await (await send(indexPath, init)).json()) as { skills: Array<{ name: string; url: string }> };
  const entry = index.skills.find((s) => s.name === slug);
  if (!entry) throw new Error(`${slug} is not in ${indexPath}`);
  return new URL(entry.url).pathname;
}

const downloads = (slug: string) => getSkill(env.db, "default", slug)?.download_count;

const logsAndDailyCount = () => [
  env.db.prepare("SELECT COUNT(*) FROM download_logs").pluck().get(),
  env.db.prepare("SELECT SUM(count) FROM download_days").pluck().get(),
];

describe("download counting", () => {
  beforeEach(resetDb);

  it("counts a CLI download of a public skill, and only that skill", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "public"]);
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");

    expect((await send(path)).status).toBe(200);
    expect(downloads("demo-skill")).toBe(1);
    expect(downloads("other-skill")).toBe(0);
  });

  it("counts browser downloads of the latest version and of a numbered version", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    expect((await send("/p/default/s/demo-skill/download")).status).toBe(200);
    expect((await send("/p/default/s/demo-skill/v/1/download")).status).toBe(200);
    expect(downloads("demo-skill")).toBe(2);
  });

  it("does not count index fetches or page views", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    await send("/.well-known/agent-skills/index.json");
    await send("/p/default/.well-known/agent-skills/index.json");
    await send(`/.well-known/agent-skills/demo-skill/.well-known/agent-skills/index.json`);
    await send("/");
    await send("/p/default/s/demo-skill");
    expect(downloads("demo-skill")).toBe(0);
  });

  it("counts a credentialed CLI download of a private skill, served uncacheable", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const key = await installKey(user.id);
    const path = await artifactPath("/p/default/.well-known/agent-skills/index.json", "other-skill", { headers: bearer(key) });

    const res = await send(path, { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(downloads("other-skill")).toBe(1);
  });

  it("refuses a private artifact on every keyless and wrong-digest address, and does not count refused requests", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const digest = getVersion(env.db, "default", "other-skill", 1)!.digest;
    const hex = digest.slice("sha256:".length);

    expect((await send(`/d/other-skill/${hex}.zip`)).status).toBe(404);
    expect((await send(`/p/default/d/other-skill/${hex}.zip`)).status).toBe(404);
    expect((await send(`/d/other-skill/${"0".repeat(64)}.zip`)).status).toBe(404);
    expect((await send("/p/default/s/other-skill/download")).status).toBe(404);
    expect((await send("/p/default/s/other-skill/v/9/download", { headers: { Cookie: cookie } })).status).toBe(404);

    seedProject("team-b", "Team B");
    joinProject(user.id, "team-b");
    const wrongKey = await installKey(user.id, "team-b");
    expect((await send(`/p/default/d/other-skill/${hex}.zip`, { headers: bearer(wrongKey) })).status).toBe(403);
    expect((await send(`/p/default/d/other-skill/${hex}.zip`, { headers: bearer(`sgi_${"0".repeat(64)}`) })).status).toBe(401);
    expect(downloads("other-skill")).toBe(0);
  });

  it("does not count HEAD requests, or a download whose stored archive is missing", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");

    expect((await send(path, { method: "HEAD" })).status).toBe(200);
    expect((await send("/p/default/s/demo-skill/download", { method: "HEAD" })).status).toBe(200);
    expect(downloads("demo-skill")).toBe(0);

    await storage.delete(getVersion(env.db, "default", "demo-skill", 1)!.object_key);
    expect((await send(path)).status).toBe(404);
    expect((await send("/p/default/s/demo-skill/download")).status).toBe(404);
    expect(downloads("demo-skill")).toBe(0);
  });

  it("counts a download while serving it, together with its log row and daily count or not at all", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    expect((await send("/p/default/s/demo-skill/download")).status).toBe(200);
    expect(downloads("demo-skill")).toBe(1);
    expect(logsAndDailyCount()).toEqual([1, 1]);

    env.db.exec(
      "CREATE TRIGGER reject_count_write BEFORE UPDATE OF download_count ON skills BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await send("/p/default/s/demo-skill/download")).status).toBe(200);
      expect(error).toHaveBeenCalledWith("download record write failed", expect.anything());
    } finally {
      error.mockRestore();
      env.db.exec("DROP TRIGGER reject_count_write");
    }
    expect(downloads("demo-skill")).toBe(1);
    expect(logsAndDailyCount()).toEqual([1, 1]);
  });
});
