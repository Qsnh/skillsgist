import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setVisibility } from "../src/db/queries";
import { buildIndex } from "../src/registry";
import type { IndexSource } from "../src/registry";
import {
  env, GOOD_MD, ORIGIN, OTHER_MD, publishMarkdown as publish, resetDb, seedAndLogin,
} from "./helpers";

const NAME_RE = /^[a-z0-9-]+$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// 逐条对应 spec 3.2 节，即 CLI 源码里的 isValidSkillEntryV2
function assertValidEntry(entry: Record<string, unknown>) {
  const name = entry.name as string;
  expect(typeof name).toBe("string");
  expect(name.length).toBeGreaterThanOrEqual(1);
  expect(name.length).toBeLessThanOrEqual(64);
  expect(NAME_RE.test(name)).toBe(true);
  expect(name.startsWith("-")).toBe(false);
  expect(name.endsWith("-")).toBe(false);
  expect(name.includes("--")).toBe(false);
  const description = entry.description as string;
  expect(typeof description).toBe("string");
  expect(description.length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(["skill-md", "archive"]).toContain(entry.type);
  expect(typeof entry.url).toBe("string");
  expect((entry.url as string).length).toBeGreaterThan(0);
  expect(DIGEST_RE.test(entry.digest as string)).toBe(true);
}

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;

/** Run `buildIndex` with console.warn captured, so the drops can be asserted. */
function buildCapturingWarnings(rows: IndexSource[]) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return { result: buildIndex(rows, "https://example.com"), warnings: warn.mock.calls.map((c) => c.join(" ")) };
  } finally {
    warn.mockRestore();
  }
}

// Final-review Fix 5 (spec gap): spec §9 requires logging a warning when
// buildIndex drops a row that fails its own name/description/digest
// self-check, so an operator has some signal if that branch is ever
// reached. It's defense-in-depth — normalizeUpload already rejects a bad
// name/description at publish time — but a bare `continue` gave zero
// visibility if it were ever hit anyway.
describe("buildIndex", () => {
  it("does not warn for rows that pass every check", () => {
    const { result, warnings } = buildCapturingWarnings([
      { slug: "demo-skill", description: "fine", digest: VALID_DIGEST },
    ]);
    expect(result.skills).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["an invalid name", { slug: "Bad_Name", description: "fine", digest: VALID_DIGEST }, "Bad_Name"],
    ["an invalid description", { slug: "demo-skill", description: "", digest: VALID_DIGEST }, "demo-skill"],
    ["a malformed digest", { slug: "demo-skill", description: "fine", digest: "not-a-digest" }, "demo-skill"],
  ])("warns and drops a row with %s", (_label, row, mentioned) => {
    const { result, warnings } = buildCapturingWarnings([row]);
    expect(result.skills).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(mentioned);
  });
});

describe("registry index", () => {
  beforeEach(resetDb);

  it("lists only public skills at the root", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const body = await res.json<{ $schema: string; skills: Record<string, unknown>[] }>();
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills.map((s) => s.name)).toEqual(["demo-skill"]);
    for (const entry of body.skills) assertValidEntry(entry);
  });

  it("serves the alias path", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch(`${ORIGIN}/.well-known/skills/index.json`);
    expect(res.status).toBe(200);
  });

  it("includes private skills for a valid install key", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const res = await SELF.fetch(
      `${ORIGIN}/i/${user.install_key}/.well-known/agent-skills/index.json`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Record<string, unknown>[] }>();
    expect(body.skills.map((s) => s.name).sort()).toEqual(["demo-skill", "other-skill"]);
    for (const entry of body.skills) {
      assertValidEntry(entry);
      expect(entry.url as string).toContain(`/i/${user.install_key}/`);
    }
  });

  it("serves the nested index path the CLI uses for single-skill installs", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    const res = await SELF.fetch(
      `${ORIGIN}/i/${user.install_key}/.well-known/agent-skills/other-skill/.well-known/agent-skills/index.json`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Record<string, unknown>[] }>();
    expect(body.skills.map((s) => s.name)).toContain("other-skill");
  });

  it("returns 404 for an unknown install key", async () => {
    const res = await SELF.fetch(`${ORIGIN}/i/deadbeef/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(404);
  });

  it("does not leak a skill after it is made private again", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await setVisibility(env.DB, "demo-skill", "private");
    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/index.json`);
    const body = await res.json<{ skills: unknown[] }>();
    expect(body.skills).toEqual([]);
  });
});

describe("artifact download", () => {
  beforeEach(resetDb);

  it("serves bytes whose sha256 equals the digest in the index", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");

    const index = await (
      await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/index.json`)
    ).json<{ skills: Array<{ url: string; digest: string }> }>();
    const entry = index.skills[0];

    const res = await SELF.fetch(entry.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");

    const bytes = new Uint8Array(await res.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(`sha256:${hex}`).toBe(entry.digest);
  });

  it("refuses public access to a private artifact", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    const index = await (
      await SELF.fetch(`${ORIGIN}/i/${user.install_key}/.well-known/agent-skills/index.json`)
    ).json<{ skills: Array<{ url: string; digest: string }> }>();
    const entry = index.skills[0];

    const viaKey = await SELF.fetch(entry.url);
    expect(viaKey.status).toBe(200);
    expect(viaKey.headers.get("Cache-Control")).toBe("private, no-store");

    const withoutKey = entry.url.replace(`/i/${user.install_key}`, "");
    expect((await SELF.fetch(withoutKey)).status).toBe(404);
  });

  it("returns 404 for a digest that does not match any version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch(`${ORIGIN}/d/demo-skill/${"0".repeat(64)}.zip`);
    expect(res.status).toBe(404);
  });
});
