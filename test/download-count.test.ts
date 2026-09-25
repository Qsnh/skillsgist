import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, getVersion } from "../src/db/queries";
import app from "../src/index";
import { env, GOOD_MD, installKey, ORIGIN, OTHER_MD, publishMarkdown as publish, resetDb, seedAndLogin } from "./helpers";

async function settle(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function artifactPath(indexPath: string, slug: string): Promise<string> {
  const index = await (await settle(indexPath)).json<{ skills: Array<{ name: string; url: string }> }>();
  const entry = index.skills.find((s) => s.name === slug);
  if (!entry) throw new Error(`${slug} is not in ${indexPath}`);
  return new URL(entry.url).pathname;
}

const downloads = async (slug: string) => (await getSkill(env.DB, "default", slug))?.download_count;

describe("download counting", () => {
  beforeEach(resetDb);

  it("counts a CLI download of a public skill, and only that skill", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");

    expect((await settle(path)).status).toBe(200);
    expect(await downloads("demo-skill")).toBe(1);
    expect(await downloads("other-skill")).toBe(0);
  });

  it("counts a keyed CLI download of a private skill", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    const path = await artifactPath(`/i/${await installKey(user.id)}/.well-known/agent-skills/index.json`, "other-skill");

    expect((await settle(path)).status).toBe(200);
    expect(await downloads("other-skill")).toBe(1);
  });

  it("counts browser downloads of the latest version and of a numbered version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");

    expect((await settle("/p/default/s/demo-skill/download")).status).toBe(200);
    expect((await settle("/p/default/s/demo-skill/v/1/download")).status).toBe(200);
    expect(await downloads("demo-skill")).toBe(2);
  });

  it("does not count index fetches or page views", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");

    await settle("/.well-known/agent-skills/index.json");
    await settle(`/i/${await installKey(user.id)}/.well-known/agent-skills/index.json`);
    await settle(`/.well-known/agent-skills/demo-skill/.well-known/agent-skills/index.json`);
    await settle("/");
    await settle("/p/default/s/demo-skill");
    expect(await downloads("demo-skill")).toBe(0);
  });

  it("does not count refused requests", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    const key = await installKey(user.id);
    const keyed = await artifactPath(`/i/${key}/.well-known/agent-skills/index.json`, "other-skill");

    expect((await settle(keyed.replace(`/i/${key}`, ""))).status).toBe(404);
    expect((await settle(keyed.replace(`/i/${key}`, "/p/default"))).status).toBe(404);
    expect((await settle(keyed.replace(key, "0".repeat(32)))).status).toBe(404);
    expect((await settle(`/d/other-skill/${"0".repeat(64)}.zip`)).status).toBe(404);
    expect((await settle("/p/default/s/other-skill/download")).status).toBe(404);
    expect((await settle("/p/default/s/other-skill/v/9/download", { headers: { Cookie: cookie } })).status).toBe(404);
    expect(await downloads("other-skill")).toBe(0);
  });

  it("does not count a download whose stored archive is missing", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");
    await env.BUCKET.delete((await getVersion(env.DB, "default", "demo-skill", 1))!.r2_key);

    expect((await settle(path)).status).toBe(404);
    expect((await settle("/p/default/s/demo-skill/download")).status).toBe(404);
    expect(await downloads("demo-skill")).toBe(0);
  });

  it("does not count HEAD requests", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const path = await artifactPath("/.well-known/agent-skills/index.json", "demo-skill");

    expect((await settle(path, { method: "HEAD" })).status).toBe(200);
    expect((await settle("/p/default/s/demo-skill/download", { method: "HEAD" })).status).toBe(200);
    expect(await downloads("demo-skill")).toBe(0);
  });

  it("still serves the archive when the count cannot be written", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
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
