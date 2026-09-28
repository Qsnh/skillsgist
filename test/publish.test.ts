import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill, getVersion, listVersions } from "../src/db/queries";
import { sha256Hex } from "../src/hash";
import { readZip } from "../src/skills/zip";
import {
  denyPublish, env, fixture, FLAT_FILES, GOOD_MD, joinProject, ORIGIN, OTHER_MD, postMultipart, putSkill, resetDb,
  seedAndLogin, seedAndToken, seedProject,
} from "./helpers";

const flatZip = () => new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" });
const pathsOf = (files: string) => (JSON.parse(files) as Array<{ path: string }>).map((f) => f.path);
const crlf = (text: string) => text.replace(/\n/g, "\r\n");
const html = async (path: string, cookie: string) =>
  (await SELF.fetch(`${ORIGIN}${path}`, { headers: { Cookie: cookie } })).text();

const inTwoProjects = async () => {
  await seedProject("team-b", "Team B");
  const alice = await seedAndToken({ username: "alice", role: "member" });
  await joinProject(alice.user.id, "team-b");
  return alice;
};

describe("PUT /api/projects/:project/skills/:slug", () => {
  beforeEach(resetDb);

  it("publishes a zip and stores the artifact in R2", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const res = await putSkill(token, fixture("WRAPPED_ZIP"), { contentType: "application/zip" });
    expect(res.status).toBe(201);
    const body = await res.json<{ slug: string; version: number; digest: string }>();
    expect(body).toMatchObject({ slug: "demo-skill", project: "default", version: 1 });
    const object = await env.BUCKET.get((await getVersion(env.DB, "default", "demo-skill", 1))!.r2_key);
    expect(object).not.toBeNull();
    expect(body.digest).toBe(`sha256:${await sha256Hex(new Uint8Array(await object!.arrayBuffer()))}`);
  });

  it("stores rendered html without the frontmatter alongside the version", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    await putSkill(token, GOOD_MD);
    const version = await getVersion(env.DB, "default", "demo-skill", 1);
    expect(version?.html).toContain("<h1");
    expect(version?.html).not.toContain("name: demo-skill");
    expect(version?.html).not.toContain("<hr");
  });

  it.each([
    ["a slug that disagrees with the frontmatter name", GOOD_MD, { slug: "other-name" }, "demo-skill"],
    ["an upload normalization rejects", fixture("NO_SKILL_MD_ZIP"), { contentType: "application/zip" }, "SKILL.md"],
  ])("answers 400 with a reason for %s", async (_label, body, opts, reason) => {
    const { token } = await seedAndToken({ username: "alice" });
    const res = await putSkill(token, body, opts);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining(reason) });
  });

  it("rejects requests without a valid api token", async () => {
    const res = await putSkill("sgt_deadbeef", GOOD_MD);
    expect(res.status).toBe(404);
  });

  it("stops a member overwriting another user's skill", async () => {
    const alice = await seedAndToken({ username: "alice" });
    await putSkill(alice.token, GOOD_MD);
    const bob = await seedAndToken({ username: "bob", role: "member" });
    const res = await putSkill(bob.token, `${GOOD_MD}\nbob was here\n`);
    expect(res.status).toBe(403);
  });

  // Omitting `?visibility` entirely on a republish must mean "not supplied",
  // not "supplied as private" — both cases used to collapse to the same value
  // at the call site.
  it("leaves visibility unchanged when an API republish omits ?visibility", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    await putSkill(token, GOOD_MD, { visibility: "public" });
    const res = await putSkill(token, `${GOOD_MD}\nno visibility param this time\n`);
    expect(res.status).toBe(201);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
  });

  // A failed/missing R2 object for the current latest
  // version must be self-healed by republishing identical bytes, not
  // masked forever behind `{ unchanged: true }`. Simulates the failure by
  // deleting the R2 object directly, the same way an interrupted
  // `BUCKET.put` (R2 error, isolate killed at the CPU/memory limit) would
  // leave things.
  it("repairs a missing R2 object, without a new version, when republishing identical bytes", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const put = () => putSkill(token, GOOD_MD);
    expect((await put()).status).toBe(201);
    const { r2_key } = (await getVersion(env.DB, "default", "demo-skill", 1))!;
    await env.BUCKET.delete(r2_key);
    const second = await put();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ unchanged: true, version: 1 });
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
    expect(await env.BUCKET.get(r2_key)).not.toBeNull();
  });

  it("applies ?visibility on an unchanged republish", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    await putSkill(token, GOOD_MD, { visibility: "private" });

    const res = await putSkill(token, GOOD_MD, { visibility: "public" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true, version: 1 });
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
  });
});

describe("POST /new", () => {
  beforeEach(resetDb);

  it("publishes an uploaded file", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await postMultipart("/new", cookie, { file: flatZip(), visibility: "public" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/default/s/demo-skill");
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
  });

  it("requires a login", async () => {
    const res = await SELF.fetch(`${ORIGIN}/new`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  // Alice publishes a skill as public, then republishes through /new with
  // "private" selected, and it must actually go private — this used to stay
  // public silently, with a 302 success and no warning.
  it("applies visibility=private on republish even though the skill was already public", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });

    await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "public" });
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");

    const res = await postMultipart("/new", cookie, {
      markdown: `${GOOD_MD}\nrepublished\n`,
      visibility: "private",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("private");
  });

  it("refuses an archive identical to the latest version, repairing a missing one and leaving visibility alone", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    expect((await postMultipart("/new", cookie, { file: flatZip() })).status).toBe(302);
    const { r2_key } = (await getVersion(env.DB, "default", "demo-skill", 1))!;
    await env.BUCKET.delete(r2_key);

    const res = await postMultipart("/new", cookie, { file: flatZip(), visibility: "public" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("identical to v1, the latest version of demo-skill");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
    expect(await env.BUCKET.get(r2_key)).not.toBeNull();
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("private");
  });

  it("publishes content identical to an older version as a new version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });
    await postMultipart("/new", cookie, { markdown: `${GOOD_MD}\nchanged\n` });

    const res = await postMultipart("/new", cookie, { markdown: GOOD_MD });
    expect(res.status).toBe(302);
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(3);
  });

  it("answers identical content on another user's skill with forbidden", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", alice.cookie, { markdown: GOOD_MD });

    const bob = await seedAndLogin({ username: "bob", role: "member" });
    const res = await postMultipart("/new", bob.cookie, { markdown: GOOD_MD });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("identical");
  });

  it("refuses pasted markdown identical to the latest version when the browser sends CRLF", async () => {
    const { cookie, token } = await seedAndToken({ username: "alice" });
    await putSkill(token, GOOD_MD);

    const res = await postMultipart("/new", cookie, { markdown: crlf(GOOD_MD) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("identical to v1");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
  });
});

describe("POST /p/:project/s/:slug/edit", () => {
  beforeEach(resetDb);

  // The edit path must never pass a visibility at all, so a public skill
  // stays public across an edit-triggered republish. This side always
  // behaved correctly but had no test pinning it.
  it("saves edited markdown as a new version without changing visibility", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "public" });

    const res = await postMultipart("/p/default/s/demo-skill/edit", cookie, {
      markdown: `${GOOD_MD}\nedited\n`,
    });
    expect(res.status).toBe(302);
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(2);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
  });

  // On a text-only edit, files under references/ and scripts/ in the old
  // version must carry over untouched. They used to be dropped silently: the
  // text box content was treated as the whole upload body, normalizeUpload read
  // bare markdown as "a skill containing only SKILL.md", and the page still
  // answered 302 success.
  it("carries SKILL.md's sibling files into the new version and its stored artifact on a text-only edit", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { file: flatZip() });
    const v1 = await getVersion(env.DB, "default", "demo-skill", 1);

    const res = await postMultipart("/p/default/s/demo-skill/edit", cookie, {
      markdown: `${v1!.skill_md}\nedited\n`,
    });
    expect(res.status).toBe(302);

    const v2 = await getVersion(env.DB, "default", "demo-skill", 2);
    expect(v2!.skill_md).toContain("edited");
    expect(pathsOf(v2!.files)).toEqual(FLAT_FILES);
    const object = await env.BUCKET.get(v2!.r2_key);
    expect(object).not.toBeNull();
    const unpacked = await readZip(new Uint8Array(await object!.arrayBuffer()));
    expect([...unpacked.keys()].sort()).toEqual(FLAT_FILES);
    expect(new TextDecoder().decode(unpacked.get("SKILL.md")!)).toContain("edited");
  });

  // When the previous archive cannot be read, refuse rather than publish a new version quietly missing files.
  it("refuses a text-only edit when the current archive is missing from storage", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { file: flatZip() });
    const v1 = await getVersion(env.DB, "default", "demo-skill", 1);
    await env.BUCKET.delete(v1!.r2_key);

    const res = await postMultipart("/p/default/s/demo-skill/edit", cookie, {
      markdown: `${v1!.skill_md}\nedited\n`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Upload a complete archive");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
  });

  it.each([
    ["a save that changes nothing", GOOD_MD, (text: string) => text],
    ["an untouched save when the skill carries other files", fixture("FLAT_ZIP"), (text: string) => text],
    ["an untouched save that the browser submits with CRLF line endings", fixture("FLAT_ZIP"), crlf],
    ["an untouched save when the stored SKILL.md has CRLF line endings", crlf(GOOD_MD), (text: string) => text],
    ["an untouched save when the stored SKILL.md lacks a trailing newline", GOOD_MD.trimEnd(), (text: string) => text],
  ])("refuses %s", async (_label, stored, submit) => {
    const { cookie, token } = await seedAndToken({ username: "alice" });
    await putSkill(token, stored);
    const v1 = await getVersion(env.DB, "default", "demo-skill", 1);

    const res = await postMultipart("/p/default/s/demo-skill/edit", cookie, { markdown: submit(v1!.skill_md) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("identical to v1, the latest version of demo-skill");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
  });
});

describe("POST /p/:project/s/:slug/upload", () => {
  beforeEach(resetDb);

  it("publishes an uploaded archive as a new version, keeping visibility, and refuses it a second time", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "public" });
    const upload = () => postMultipart("/p/default/s/demo-skill/upload", cookie, { file: flatZip() });

    const res = await upload();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/default/s/demo-skill");
    expect(pathsOf((await getVersion(env.DB, "default", "demo-skill", 2))!.files)).toEqual(FLAT_FILES);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");

    const again = await upload();
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("identical to v2, the latest version of demo-skill");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(2);
  });

  it("rejects an archive whose name disagrees with the slug", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const res = await postMultipart("/p/default/s/demo-skill/upload", cookie, {
      file: new File([OTHER_MD], "SKILL.md", { type: "text/markdown" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("other-skill");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
  });

  it("re-renders the page when no file was chosen", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const res = await postMultipart("/p/default/s/demo-skill/upload", cookie, {});
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Choose an archive");
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
  });

  it("stops a member updating another user's skill", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", alice.cookie, { markdown: GOOD_MD });

    const bob = await seedAndLogin({ username: "bob", role: "member" });
    const res = await postMultipart("/p/default/s/demo-skill/upload", bob.cookie, { file: flatZip() });
    expect(res.status).toBe(403);
  });
});

// Edit and upload are two separate roads, each with exactly one kind of input.
// These two pin the shape of the pages themselves: the moment someone moves the
// file input back onto the edit page, the "both were filled in, which wins?"
// rule comes back with it.
describe("edit and upload each take exactly one kind of input", () => {
  beforeEach(resetDb);

  it("gives the edit page a textarea naming the carried files, and the upload page only a file input", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { file: flatZip() });

    const edit = await html("/p/default/s/demo-skill/edit", cookie);
    expect(edit).toContain("<textarea");
    expect(edit).not.toContain('type="file"');
    expect(edit).toContain("references/api.md");
    expect(edit).toContain("scripts/run.sh");
    const upload = await html("/p/default/s/demo-skill/upload", cookie);
    expect(upload).toContain('type="file"');
    expect(upload).not.toContain("<textarea");
    await postMultipart("/new", cookie, { markdown: OTHER_MD });
    expect(await html("/p/default/s/other-skill/edit", cookie)).not.toContain('type="file"');
  });
});

describe("publishing into a project", () => {
  beforeEach(resetDb);

  it("publishes through /api/projects/:project/skills/:slug", async () => {
    const { token } = await inTwoProjects();
    const res = await putSkill(token, GOOD_MD, { project: "team-b" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ project: "team-b", slug: "demo-skill", version: 1 });
    expect((await getSkill(env.DB, "team-b", "demo-skill"))?.project).toBe("team-b");
    expect(await getSkill(env.DB, "default", "demo-skill")).toBeNull();
  });

  it("no longer publishes through the old /api/skills/:slug address", async () => {
    const { token } = await inTwoProjects();
    const res = await SELF.fetch(`${ORIGIN}/api/skills/demo-skill`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(404);
    expect(await getSkill(env.DB, "default", "demo-skill")).toBeNull();
    expect(await getSkill(env.DB, "team-b", "demo-skill")).toBeNull();
  });

  it("keeps skills with the same name in two projects separate", async () => {
    const { token } = await inTwoProjects();
    await putSkill(token, GOOD_MD, { project: "default" });
    const res = await putSkill(token, `${GOOD_MD}\nteam b\n`, { project: "team-b" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 1 });
    expect(await listVersions(env.DB, "default", "demo-skill")).toHaveLength(1);
    expect(await listVersions(env.DB, "team-b", "demo-skill")).toHaveLength(1);
  });

  it("refuses a project the publisher is not in, or one that does not exist", async () => {
    await seedProject("team-b", "Team B");
    const { token } = await seedAndToken({ username: "alice", role: "member" });
    for (const project of ["team-b", "nope"]) {
      const res = await putSkill(token, GOOD_MD, { project });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "forbidden",
        message: `There is no project named ${project} that you can publish to`,
      });
      expect(await getSkill(env.DB, project, "demo-skill")).toBeNull();
    }
  });

  it("does not tell an outsider whether a name is taken in a project", async () => {
    await seedProject("team-b", "Team B");
    const bob = await seedAndToken({ username: "bob", role: "member", project: "team-b" });
    await putSkill(bob.token, GOOD_MD, { project: "team-b" });
    const alice = await seedAndToken({ username: "alice", role: "member" });
    const taken = await putSkill(alice.token, GOOD_MD, { project: "team-b" });
    const free = await putSkill(alice.token, OTHER_MD, { project: "team-b", slug: "other-skill" });
    expect(taken.status).toBe(403);
    expect(await taken.json()).toEqual(await free.json());
    expect(await listVersions(env.DB, "team-b", "demo-skill")).toHaveLength(1);
  });

  it("lets an instance admin in no project publish into any project", async () => {
    await seedProject("team-b", "Team B");
    const { token } = await seedAndToken({ username: "root", role: "admin", project: null });
    expect((await putSkill(token, GOOD_MD, { project: "team-b" })).status).toBe(201);
    expect(await getSkill(env.DB, "team-b", "demo-skill")).not.toBeNull();
  });

  // `versions.author_id` must record
  // who actually published a version, not who owns the skill — otherwise
  // the column is just a copy of `skills.owner_id` and can never show that
  // an admin published on someone else's behalf. Ownership itself must
  // stay put: `insertVersion`'s ON CONFLICT clause never touches owner_id.
  it("lets a project admin publish a new version of a member's skill, recorded as its author", async () => {
    const carol = await seedAndToken({ username: "carol", role: "member" });
    await putSkill(carol.token, GOOD_MD);
    const lead = await seedAndToken({ username: "lead", role: "member", projectRole: "admin" });
    const res = await putSkill(lead.token, `${GOOD_MD}\nlead edit\n`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2 });
    expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(carol.user.id);
    expect((await getVersion(env.DB, "default", "demo-skill", 2))?.author_id).toBe(lead.user.id);
  });
});

describe("the project select on /new", () => {
  beforeEach(resetDb);

  const optionsOn = async (cookie: string) =>
    [...(await html("/new", cookie)).matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

  it("offers exactly the projects a member is in, by name", async () => {
    await seedProject("team-b", "Team B");
    await seedProject("team-c", "Team C");
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await joinProject(alice.user.id, "team-c");
    expect(await optionsOn(alice.cookie)).toEqual([["default", "Default"], ["team-c", "Team C"]]);
  });

  it("leaves out a project where the member's publishing is blocked", async () => {
    const alice = await inTwoProjects();
    await denyPublish(alice.user.id, "team-b");
    expect(await optionsOn(alice.cookie)).toEqual([["default", "Default"]]);
  });

  it("offers every project to an instance admin", async () => {
    await seedProject("team-b", "Team B");
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });
    expect(await optionsOn(root.cookie)).toEqual([["default", "Default"], ["team-b", "Team B"]]);
  });

  it("preselects the project named in ?project=", async () => {
    const { cookie } = await inTwoProjects();
    const page = await html("/new?project=team-b", cookie);
    expect(page).toContain('<option value="team-b" selected="">Team B</option>');
    expect(page).toContain('<option value="" disabled="">Choose a project</option>');
    expect(await html("/new", cookie)).toContain('<option value="" disabled="" selected="">Choose a project</option>');
  });

  it("ignores a ?project= the user cannot publish to", async () => {
    await seedProject("team-b", "Team B");
    await seedProject("team-c", "Team C");
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await joinProject(alice.user.id, "team-c");
    const page = await html("/new?project=team-b", alice.cookie);
    expect(page).toContain('<option value="" disabled="" selected="">Choose a project</option>');
    expect(page).not.toContain("Team B");
  });

  it("shows no placeholder when a member is in exactly one project", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    const page = await html("/new", alice.cookie);
    expect(page).not.toContain("Choose a project");
    expect(page).toContain('<option value="default">Default</option>');
  });

  it("publishes into the chosen project and lands on the skill there", async () => {
    const { cookie } = await inTwoProjects();
    const res = await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "private", project: "team-b" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/team-b/s/demo-skill");
    expect(await getSkill(env.DB, "team-b", "demo-skill")).not.toBeNull();
  });

  it("asks a user in several projects to choose one when the form sends none", async () => {
    const { cookie } = await inTwoProjects();
    const res = await postMultipart("/new", cookie, { markdown: GOOD_MD });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Choose which project this skill goes into");
  });

  it("keeps the chosen project when it re-renders with an error", async () => {
    const { cookie } = await inTwoProjects();
    const res = await postMultipart("/new", cookie, { markdown: "no frontmatter", project: "team-b" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<option value="team-b" selected="">Team B</option>');
  });

  it("refuses a project the user is not in", async () => {
    await seedProject("team-b", "Team B");
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    const res = await postMultipart("/new", alice.cookie, { markdown: GOOD_MD, project: "team-b" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("There is no project named team-b that you can publish to");
    expect(await getSkill(env.DB, "team-b", "demo-skill")).toBeNull();
  });

  it("tells a user in no project that there is nowhere to publish", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member", project: null });
    const page = await html("/new", alice.cookie);
    expect(page).toContain("You are not in a project yet.");
    expect(page).not.toContain('name="file"');
  });
});
