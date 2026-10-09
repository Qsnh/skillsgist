import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getVersion } from "../src/db/queries";
import app from "../src/index";
import {
  apiToken, bearer, env, fetchWith, GOOD_MD, installKey, joinProject, ORIGIN, OTHER_MD, postForm, publishMarkdown as publish,
  resetDb, seedAndLogin, seedProject, seedWithSkills, signInDevice,
} from "./helpers";

const INDEX = "/p/default/.well-known/agent-skills/index.json";
const SKILL_INDEX = (slug: string) => `/p/default/.well-known/agent-skills/${slug}/.well-known/agent-skills/index.json`;
const DAY = 24 * 60 * 60 * 1000;

const names = async (res: Response) => (await res.json<{ skills: Array<{ name: string }> }>()).skills.map((s) => s.name);

async function privateArtifact(slug = "other-skill") {
  const digest = (await getVersion(env.DB, "default", slug, 1))!.digest;
  return `/p/default/d/${slug}/${digest.slice("sha256:".length)}.zip`;
}

function expectPrivate(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("Vary")).toContain("Authorization");
}

beforeEach(async () => {
  await resetDb();
  await seedProject("team-b", "Team B");
});

describe("install keys", () => {
  it("open every skill of their project, index and artifact, and nothing is cacheable", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const key = await installKey(user.id);
    const index = await fetchWith(INDEX, bearer(key));
    expect(index.status).toBe(200);
    expectPrivate(index);
    expect(await names(index)).toEqual(["demo-skill", "other-skill"]);
    const artifact = await fetchWith(await privateArtifact(), bearer(key));
    expect(artifact.status).toBe(200);
    expectPrivate(artifact);
  });

  it("open another project's public skills, and answer its private ones with 403 wrong_project naming their own", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    await joinProject(user.id, "team-b");
    const key = await installKey(user.id, "team-b");
    const index = await fetchWith(INDEX, bearer(key));
    expect(index.status).toBe(200);
    expectPrivate(index);
    expect(await names(index)).toEqual(["demo-skill"]);
    expect(await names(await fetchWith(SKILL_INDEX("demo-skill"), bearer(key)))).toEqual(["demo-skill"]);
    const open = await fetchWith(await privateArtifact("demo-skill"), bearer(key));
    expect(open.status).toBe(200);
    expect(open.headers.get("Cache-Control")).toBe("public, max-age=300");
    for (const path of [SKILL_INDEX("other-skill"), await privateArtifact()]) {
      const res = await fetchWith(path, bearer(key));
      expect(res.status, path).toBe(403);
      expectPrivate(res);
      expect(await res.json()).toEqual({ error: "wrong_project", project: "team-b" });
    }
  });

  it("answer another project with no public skills with 403 wrong_project", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    await joinProject(user.id, "team-b");
    const res = await fetchWith(INDEX, bearer(await installKey(user.id, "team-b")));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "wrong_project", project: "team-b" });
  });

  it("stop at once when reset or when the membership is gone", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const first = await installKey(user.id);
    expect((await fetchWith(INDEX, bearer(first))).status).toBe(200);
    await postForm("/p/default/install-key", cookie);
    const second = await installKey(user.id);
    expect((await fetchWith(INDEX, bearer(first))).status).toBe(401);
    expect((await fetchWith(INDEX, bearer(second))).status).toBe(200);
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(user.id).run();
    expect((await fetchWith(INDEX, bearer(second))).status).toBe(401);
  });
});

describe("device sign-ins", () => {
  it("open the granted projects, show public skills elsewhere, and refuse a member's other private skills with project_not_granted", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
    await publish(bob.cookie, OTHER_MD, "private", "team-b");
    await joinProject(user.id, "team-b");
    const { token } = await signInDevice(user.id, ["team-b"]);
    expect(await names(await fetchWith("/p/team-b/.well-known/agent-skills/index.json", bearer(token)))).toEqual(["other-skill"]);
    expect(await names(await fetchWith(INDEX, bearer(token)))).toEqual(["demo-skill"]);
    for (const path of [SKILL_INDEX("other-skill"), await privateArtifact()]) {
      const refused = await fetchWith(path, bearer(token));
      expect(refused.status, path).toBe(403);
      expect(await refused.json()).toEqual({ error: "project_not_granted", project: "default" });
    }

    const outsider = await signInDevice(bob.user.id, ["team-b"]);
    const open = await fetchWith(INDEX, bearer(outsider.token));
    expect(open.status).toBe(200);
    expect(await names(open)).toEqual(["demo-skill"]);
    expect((await fetchWith(await privateArtifact(), bearer(outsider.token))).status).toBe(404);
  });

  it("download a private artifact of a granted project, uncacheable", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const { token } = await signInDevice(user.id, ["default"]);
    const index = await (await fetchWith(INDEX, bearer(token))).json<{ skills: Array<{ name: string; url: string; digest: string }> }>();
    const entry = index.skills.find((s) => s.name === "other-skill")!;
    const res = await fetchWith(await privateArtifact(), bearer(token));
    expect(res.status).toBe(200);
    expectPrivate(res);
    const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
    expect(`sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`).toBe(entry.digest);
    expect(new URL(entry.url).pathname).toBe(await privateArtifact());
  });

  it("give an instance admin only the public skills of a project they are not a member of", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const root = await seedAndLogin({ username: "root", role: "admin", project: "team-b" });
    const { token } = await signInDevice(root.user.id, ["team-b"]);
    const res = await fetchWith(INDEX, bearer(token));
    expect(res.status).toBe(200);
    expectPrivate(res);
    expect(await names(res)).toEqual(["demo-skill"]);
    expect((await fetchWith(await privateArtifact(), bearer(token))).status).toBe(404);
    expect(await (await fetchWith("/api/whoami", bearer(token))).json()).toEqual({ user: "root", kind: "login", projects: ["team-b"] });

    const key = await installKey(root.user.id, "team-b");
    expect(await names(await fetchWith(INDEX, bearer(key)))).toEqual(["demo-skill"]);
    const refused = await fetchWith(await privateArtifact(), bearer(key));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "wrong_project", project: "team-b" });
  });

  it("lose a project when the member leaves it, and do not get it back when they rejoin", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const admin = await seedAndLogin({ username: "root", role: "admin", project: null });
    const { token } = await signInDevice(user.id, ["default"]);
    await postForm(`/p/default/members/${user.id}/remove`, admin.cookie);
    expect(await names(await fetchWith(INDEX, bearer(token)))).toEqual(["demo-skill"]);
    await joinProject(user.id, "default");
    expect(await names(await fetchWith(INDEX, bearer(token)))).toEqual(["demo-skill"]);
    expect((await fetchWith(await privateArtifact(), bearer(token))).status).toBe(403);
  });

  it("stop working after 90 days unused, and record use at most once an hour", async () => {
    const { user } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const stale = await signInDevice(user.id, ["default"], Date.now() - 90 * DAY - 1000);
    expect((await fetchWith(INDEX, bearer(stale.token))).status).toBe(401);

    const recent = await signInDevice(user.id, ["default"], Date.now() - 30 * 60 * 1000);
    const lastUsed = async () =>
      (await env.DB.prepare("SELECT last_used_at FROM cli_logins WHERE id = ?").bind(recent.id).first<{ last_used_at: number }>())!.last_used_at;
    const before = await lastUsed();
    const settle = async () => {
      const ctx = createExecutionContext();
      await app.fetch(new Request(`${ORIGIN}${INDEX}`, { headers: bearer(recent.token) }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    await settle();
    expect(await lastUsed()).toBe(before);
    await env.DB.prepare("UPDATE cli_logins SET last_used_at = ? WHERE id = ?").bind(Date.now() - 2 * 60 * 60 * 1000, recent.id).run();
    await settle();
    expect(await lastUsed()).toBeGreaterThan(Date.now() - 60 * 1000);
  });
});

describe("credentials the registry refuses or ignores", () => {
  it.each([
    ["an unknown install key", `Bearer sgi_${"0".repeat(64)}`],
    ["an unknown sign-in token", `Bearer sgd_${"0".repeat(64)}`],
    ["a publish API token", `Bearer sgt_${"0".repeat(32)}`],
    ["an unprefixed token", "Bearer abc"],
    ["Bearer with no token", "Bearer"],
    ["two tokens", "Bearer a b"],
  ])("answers %s with 401 and a Bearer challenge, uncacheable", async (_label, header) => {
    await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const res = await fetchWith(INDEX, { Authorization: header });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    expectPrivate(res);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("serves public skills to a bad credential and answers private ones with 401", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const junk = bearer(`sgd_${"0".repeat(64)}`);
    const index = await fetchWith(INDEX, junk);
    expect(index.status).toBe(200);
    expectPrivate(index);
    expect(await names(index)).toEqual(["demo-skill"]);
    expect((await fetchWith(await privateArtifact("demo-skill"), junk)).status).toBe(200);
    for (const path of [SKILL_INDEX("other-skill"), await privateArtifact()]) {
      const res = await fetchWith(path, junk);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    }
  });

  it("reads the Bearer scheme in any case, here and on the publish API", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const { token } = await signInDevice(user.id, ["default"]);
    expect(await names(await fetchWith(INDEX, { Authorization: `bearer ${token}` }))).toEqual(["other-skill"]);
    const res = await SELF.fetch(`${ORIGIN}/api/projects/default/skills/demo-skill`, {
      method: "PUT",
      headers: { Authorization: `BEARER   ${await apiToken(cookie)}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(201);
  });

  it("treats another Authorization scheme as anonymous", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const res = await fetchWith(INDEX, { Authorization: "Basic YTpi" });
    expect(res.status).toBe(200);
    expect(await names(res)).toEqual(["demo-skill"]);
  });

  it("ignores credentials at the root, which lists public skills only", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const res = await fetchWith("/.well-known/agent-skills/index.json", { Authorization: "Bearer junk" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await names(res)).toEqual(["demo-skill"]);
  });

  it("keeps anonymous project responses uncacheable, a private artifact a 404, and a public artifact cacheable", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    expectPrivate(await fetchWith(INDEX));
    const hidden = await fetchWith(await privateArtifact());
    expect(hidden.status).toBe(404);
    expectPrivate(hidden);
    const open = await SELF.fetch(`${ORIGIN}${await privateArtifact("demo-skill")}`);
    expect(open.status).toBe(200);
    expect(open.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});

describe("/api/whoami", () => {
  it("names the user and the usable projects of a sign-in, and the one project of an install key", async () => {
    const { user } = await seedAndLogin({ username: "alice" });
    await joinProject(user.id, "team-b");
    const { token } = await signInDevice(user.id, ["default", "team-b"]);
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = ? AND project = 'team-b'").bind(user.id).run();
    const login = await fetchWith("/api/whoami", bearer(token));
    expect(login.status).toBe(200);
    expectPrivate(login);
    const body = await login.text();
    expect(JSON.parse(body)).toEqual({ user: "alice", kind: "login", projects: ["default"] });
    expect(body).not.toContain(token);
    const key = await installKey(user.id);
    expect(await (await fetchWith("/api/whoami", bearer(key))).json()).toEqual({ user: "alice", kind: "install_key", projects: ["default"] });
  });

  it("answers no credential and a bad one with 401", async () => {
    const none = await fetchWith("/api/whoami");
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await fetchWith("/api/whoami", bearer("sgd_nope"))).status).toBe(401);
  });
});
