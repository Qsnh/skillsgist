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

// Spec §9 requires a warning when buildIndex drops a row — see the rationale
// in src/registry.ts. A bare `continue` gives an operator zero visibility.
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

  // 每个用例都发布两个 skill。只发一个的话，「按 slug 收窄」坏掉也看不出来 ——
  // CLI 对只含一条的 index 会自动选中那一条，一个未收窄的 index 里恰好只有一个
  // skill 时表现完全一样。这正是这个 bug 此前漏网的原因。
  const names = async (res: Response) =>
    (await res.json<{ skills: Array<{ name: string }> }>()).skills.map((s) => s.name);

  // CLI 装单个 skill 时会把整条 URL 当作 basePath 再拼一层 .well-known。
  // `skills add` 走 fetchAllSkills()，它返回 index 里的**全部**条目、从不看路径里
  // 的 slug —— 所以 per-skill 地址要成立，只能由服务端把 index 收窄到那一个。
  it("scopes the keyed nested index to the slug in the path", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    await publish(cookie, OTHER_MD, "private");

    const res = await SELF.fetch(
      `${ORIGIN}/i/${user.install_key}/.well-known/agent-skills/other-skill/.well-known/agent-skills/index.json`,
    );
    expect(res.status).toBe(200);
    expect(await names(res)).toEqual(["other-skill"]);
  });

  it("scopes the anonymous nested index to the slug in the path", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");

    const res = await SELF.fetch(
      `${ORIGIN}/.well-known/agent-skills/demo-skill/.well-known/agent-skills/index.json`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Record<string, unknown>[] }>();
    expect(body.skills.map((s) => s.name)).toEqual(["demo-skill"]);
    for (const entry of body.skills) assertValidEntry(entry);
  });

  // CLI 会把两个 .well-known 别名两两组合着试，所以四种嵌套都要收窄到同一个 slug。
  it("scopes the nested index under either .well-known alias", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");

    for (const outer of ["agent-skills", "skills"]) {
      for (const inner of ["agent-skills", "skills"]) {
        const res = await SELF.fetch(
          `${ORIGIN}/.well-known/${outer}/demo-skill/.well-known/${inner}/index.json`,
        );
        expect(res.status).toBe(200);
        expect(await names(res)).toEqual(["demo-skill"]);
      }
    }
  });

  // 看不见的 slug 和压根不存在的 slug 给出完全一样的空 index，所以这条路径不能
  // 被当成「某个私有 skill 是否存在」的探测器。
  //
  // 已知边角，改不掉：空 index 会让 CLI 判定这条候选无效，转而回落到根 index，
  // 于是它会列出全部公开 skill。那是 CLI 自己的兜底逻辑，服务端返 404 结果一样。
  it("returns an empty index for a slug the visitor cannot see", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const hidden = await SELF.fetch(
      `${ORIGIN}/.well-known/agent-skills/other-skill/.well-known/agent-skills/index.json`,
    );
    const missing = await SELF.fetch(
      `${ORIGIN}/.well-known/agent-skills/no-such-skill/.well-known/agent-skills/index.json`,
    );
    expect(hidden.status).toBe(200);
    expect(missing.status).toBe(200);
    expect(await names(hidden)).toEqual([]);
    expect(await names(missing)).toEqual([]);
  });

  // 通配路由只接 index 结尾的路径。裸地址保持 404 —— 带 key 的裸地址一直如此，
  // 而 CLI 从不请求裸地址，只会往后拼一层。
  it("still 404s a .well-known path that is not an index", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");

    expect((await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/demo-skill`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/demo-skill/nope.json`)).status).toBe(404);
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
