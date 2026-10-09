import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, getVersion } from "../src/db/queries";
import app from "../src/index";
import {
  bearer, env, GOOD_MD, installKey, joinProject, ORIGIN, OTHER_MD, resetDb, seedProject, seedWithSkills,
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

const downloads = async (slug: string) => (await getSkill(env.DB, "default", slug))?.download_count;

describe("download counting", () => {
  beforeEach(resetDb);

  it("counts a CLI download of a public skill, and only that skill", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "public"]);
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");

    expect((await settle(path)).status).toBe(200);
    expect(await downloads("demo-skill")).toBe(1);
    expect(await downloads("other-skill")).toBe(0);
  });

  it("counts browser downloads of the latest version and of a numbered version", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    expect((await settle("/p/default/s/demo-skill/download")).status).toBe(200);
    expect((await settle("/p/default/s/demo-skill/v/1/download")).status).toBe(200);
    expect(await downloads("demo-skill")).toBe(2);
  });

  it("does not count index fetches or page views", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    await settle("/.well-known/agent-skills/index.json");
    await settle("/p/default/.well-known/agent-skills/index.json");
    await settle(`/.well-known/agent-skills/demo-skill/.well-known/agent-skills/index.json`);
    await settle("/");
    await settle("/p/default/s/demo-skill");
    expect(await downloads("demo-skill")).toBe(0);
  });

  it("counts a credentialed CLI download of a private skill, served uncacheable", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const key = await installKey(user.id);
    const path = await artifactPath("/p/default/.well-known/agent-skills/index.json", "other-skill", { headers: bearer(key) });

    const res = await settle(path, { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await downloads("other-skill")).toBe(1);
  });

  it("refuses a private artifact on every keyless and wrong-digest address, and does not count refused requests", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const digest = (await getVersion(env.DB, "default", "other-skill", 1))!.digest;
    const hex = digest.slice("sha256:".length);

    expect((await settle(`/d/other-skill/${hex}.zip`)).status).toBe(404);
    expect((await settle(`/p/default/d/other-skill/${hex}.zip`)).status).toBe(404);
    expect((await settle(`/d/other-skill/${"0".repeat(64)}.zip`)).status).toBe(404);
    expect((await settle("/p/default/s/other-skill/download")).status).toBe(404);
    expect((await settle("/p/default/s/other-skill/v/9/download", { headers: { Cookie: cookie } })).status).toBe(404);

    await seedProject("team-b", "Team B");
    await joinProject(user.id, "team-b");
    const wrongKey = await installKey(user.id, "team-b");
    expect((await settle(`/p/default/d/other-skill/${hex}.zip`, { headers: bearer(wrongKey) })).status).toBe(403);
    expect((await settle(`/p/default/d/other-skill/${hex}.zip`, { headers: bearer(`sgi_${"0".repeat(64)}`) })).status).toBe(401);
    expect(await downloads("other-skill")).toBe(0);
  });

  it("does not count HEAD requests, or a download whose stored archive is missing", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");

    expect((await settle(path, { method: "HEAD" })).status).toBe(200);
    expect((await settle("/p/default/s/demo-skill/download", { method: "HEAD" })).status).toBe(200);
    expect(await downloads("demo-skill")).toBe(0);

    await env.BUCKET.delete((await getVersion(env.DB, "default", "demo-skill", 1))!.r2_key);
    expect((await settle(path)).status).toBe(404);
    expect((await settle("/p/default/s/demo-skill/download")).status).toBe(404);
    expect(await downloads("demo-skill")).toBe(0);
  });

  it("still serves the archive when the count cannot be written", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await env.DB.prepare(
      "CREATE TRIGGER reject_count_write BEFORE UPDATE OF download_count ON skills BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    ).run();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await settle("/p/default/s/demo-skill/download");
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(error).toHaveBeenCalledWith("download count write failed", expect.anything());
    } finally {
      error.mockRestore();
      await env.DB.prepare("DROP TRIGGER reject_count_write").run();
    }
    expect(await downloads("demo-skill")).toBe(0);
  });
});
