import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVersion, setVisibility } from "../src/db/queries";
import { buildIndex } from "../src/registry";
import type { IndexSource } from "../src/registry";
import {
  env, get, GOOD_MD, indexAt, indexNames, installKey, ORIGIN, OTHER_MD, publishMarkdown as publish, resetDb,
  seedWithSkills, twoProjects,
} from "./helpers";

const NAME_RE = /^[a-z0-9-]+$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// One case per clause of spec §3.2, i.e. isValidSkillEntryV2 in the CLI source
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

// Spec §9 requires a warning when buildIndex drops a row — see the rationale
// in src/registry.ts. A bare `continue` gives an operator zero visibility.
describe("buildIndex", () => {
  it.each([
    ["no problem", { slug: "demo-skill", description: "fine", digest: VALID_DIGEST }, 1, []],
    ["an invalid name", { slug: "Bad_Name", description: "fine", digest: VALID_DIGEST }, 0, [expect.stringContaining("Bad_Name")]],
    ["an invalid description", { slug: "demo-skill", description: "", digest: VALID_DIGEST }, 0, [expect.stringContaining("demo-skill")]],
    ["a malformed digest", { slug: "demo-skill", description: "fine", digest: "not-a-digest" }, 0, [expect.stringContaining("demo-skill")]],
  ])("keeps a row with %s only if it passes every check, and warns once for each row it drops", (_label, row, kept, warned) => {
    const { result, warnings } = buildCapturingWarnings([row]);
    expect(result.skills).toHaveLength(kept);
    expect(warnings).toEqual(warned);
  });
});

describe("registry index", () => {
  beforeEach(resetDb);

  it("lists only public skills at the root", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);

    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const body = await res.json<{ $schema: string; skills: Record<string, unknown>[] }>();
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills.map((s) => s.name)).toEqual(["demo-skill"]);
    for (const entry of body.skills) assertValidEntry(entry);
  });

  // Every case publishes two skills. With only one, a broken "narrow by slug"
  // would still look green — the CLI auto-selects the sole entry of a
  // single-entry index, so an un-narrowed index holding exactly one skill
  // behaves identically. That is precisely how this bug went unnoticed.
  // The CLI tries the two .well-known aliases in every combination, so all four nestings must narrow to the same slug.
  it("serves the root index and scopes the nested index under either .well-known alias", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "public"]);

    expect(await indexNames("", "skills")).toEqual(["demo-skill", "other-skill"]);
    for (const outer of ["agent-skills", "skills"]) {
      for (const inner of ["agent-skills", "skills"] as const) {
        expect(await indexNames(`/.well-known/${outer}/demo-skill`, inner)).toEqual(["demo-skill"]);
      }
    }
  });

  // An invisible slug and a slug that does not exist return the exact same
  // empty index, so this path cannot be used to probe whether a given private
  // skill exists.
  //
  // A known corner, and not fixable here: an empty index makes the CLI judge
  // this candidate invalid and fall back to the root index, which then lists
  // every public skill. That is the CLI's own fallback; returning 404 gets the
  // same result.
  it("returns an empty index for a slug the visitor cannot see", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);

    expect(await indexNames("/.well-known/agent-skills/other-skill")).toEqual([]);
    expect(await indexNames("/.well-known/agent-skills/no-such-skill")).toEqual([]);
  });

  it("still 404s a .well-known path that is not an index", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    expect((await get("/.well-known/agent-skills/demo-skill")).status).toBe(404);
    expect((await get("/.well-known/agent-skills/demo-skill/nope.json")).status).toBe(404);

    const projectScoped = await get("/p/default/.well-known/agent-skills/demo-skill");
    expect(projectScoped.status).toBe(404);
    expect(projectScoped.headers.get("Cache-Control")).toBe("private, no-store");
    expect(projectScoped.headers.get("Vary")).toBe("Authorization");
  });
});

describe("artifact download", () => {
  beforeEach(resetDb);

  it("serves bytes whose sha256 equals the digest in the index, and nothing for a digest that matches no version", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    const [entry] = await indexAt("");

    const res = await SELF.fetch(entry.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");

    const bytes = new Uint8Array(await res.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(`sha256:${hex}`).toBe(entry.digest);
    expect((await get(`/d/demo-skill/${"0".repeat(64)}.zip`)).status).toBe(404);
  });
});

describe("project install addresses", () => {
  beforeEach(resetDb);

  it("serves each project's public skills at /p/<project>, under either alias", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "public");
    await publish(alice.cookie, OTHER_MD, "private");
    await publish(bob.cookie, OTHER_MD, "public");

    expect(await indexNames("/p/default")).toEqual(["demo-skill"]);
    expect(await indexNames("/p/team-b")).toEqual(["other-skill"]);
    expect(await indexNames("/p/team-b", "skills")).toEqual(["other-skill"]);
    expect(await indexNames("/p/team-b/.well-known/agent-skills/other-skill")).toEqual(["other-skill"]);
    expect(await indexNames("/p/default/.well-known/agent-skills/other-skill")).toEqual([]);
    expect(await indexNames("/p/no-such-project")).toEqual([]);
  });

  it("downloads a project's public artifact but not a private one", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const entry = (await indexAt("/p/default"))[0];
    expect(entry.url).toBe(`${ORIGIN}/p/default/d/demo-skill/${entry.digest.slice("sha256:".length)}.zip`);
    const res = await SELF.fetch(entry.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");

    const digest = (await getVersion(env.DB, "default", "other-skill", 1))!.digest;
    const hex = digest.slice("sha256:".length);
    expect((await get(`/p/default/d/other-skill/${hex}.zip`)).status).toBe(404);
  });

  it("no longer serves anything under /i/", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    const key = await installKey(user.id);
    expect((await get(`/i/${key}/.well-known/agent-skills/index.json`)).status).toBe(404);
    expect((await get(`/i/${key}/d/demo-skill/${"0".repeat(64)}.zip`)).status).toBe(404);
  });

  it("keeps two public skills with the same name apart, and leaves the name out of the root index", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "public");
    await publish(bob.cookie, GOOD_MD.replace("# Demo", "# Team B demo"), "public");
    await publish(bob.cookie, OTHER_MD, "public");

    const ours = (await indexAt("/p/default"))[0];
    const theirs = (await indexAt("/p/team-b")).find((s) => s.name === "demo-skill")!;
    expect(ours.digest).not.toBe(theirs.digest);
    expect(await indexNames("")).toEqual(["other-skill"]);
    expect(await indexNames("/.well-known/agent-skills/demo-skill")).toEqual([]);

    await setVisibility(env.DB, "team-b", "demo-skill", "private");
    expect(await indexNames("")).toEqual(["demo-skill", "other-skill"]);
  });
});
