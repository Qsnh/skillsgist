import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill, getVersion, listVersions } from "../src/db/queries";
import { readZip } from "../src/skills/zip";
import {
  env, fixture, GOOD_MD, ORIGIN, OTHER_MD, postMultipart, resetDb, seedAndLogin, seedAndToken,
} from "./helpers";

/** `PUT /api/skills/:slug` — the one place this request is spelled out. */
function putSkill(
  token: string,
  body: BodyInit,
  opts: { slug?: string; contentType?: string; visibility?: string } = {},
): Promise<Response> {
  const query = opts.visibility === undefined ? "" : `?visibility=${opts.visibility}`;
  return SELF.fetch(`${ORIGIN}/api/skills/${opts.slug ?? "demo-skill"}${query}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": opts.contentType ?? "text/markdown",
    },
    body,
  });
}

describe("PUT /api/skills/:slug", () => {
  beforeEach(resetDb);

  it("publishes a zip and stores the artifact in R2", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const res = await putSkill(token, fixture("WRAPPED_ZIP"), { contentType: "application/zip" });
    expect(res.status).toBe(201);
    const body = await res.json<{ slug: string; version: number; digest: string }>();
    expect(body.slug).toBe("demo-skill");
    expect(body.version).toBe(1);
    expect(body.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const object = await env.BUCKET.get("skills/demo-skill/1.zip");
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object!.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", stored);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(body.digest).toBe(`sha256:${hex}`);
  });

  it("stores rendered html alongside the version", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    await putSkill(token, GOOD_MD);
    const version = await getVersion(env.DB, "demo-skill", 1);
    expect(version?.html).toContain("<h1");
  });

  it("does not create a new version when content is unchanged", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const put = () => putSkill(token, GOOD_MD);
    expect((await put()).status).toBe(201);
    const second = await put();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ unchanged: true, version: 1 });
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(1);
  });

  it("creates version 2 when content changes", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const put = (md: string) => putSkill(token, md);
    await put(GOOD_MD);
    const res = await put(`${GOOD_MD}\nmore text\n`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2 });
  });

  it("rejects a slug that disagrees with the frontmatter name", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const res = await putSkill(token, GOOD_MD, { slug: "other-name" });
    expect(res.status).toBe(400);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: expect.stringContaining("demo-skill"),
    });
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

  it("surfaces normalization errors as 400 with a reason", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const res = await putSkill(token, fixture("NO_SKILL_MD_ZIP"), { contentType: "application/zip" });
    expect(res.status).toBe(400);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: expect.stringContaining("SKILL.md"),
    });
  });

  // An explicitly-supplied `?visibility=` must actually apply, even when the
  // skill already exists. `insertVersion`'s ON CONFLICT clause intentionally
  // never touches `visibility` — that's what keeps a no-visibility edit from
  // resetting a public skill to private — but that same short-circuit used to
  // discard a visibility the caller *did* explicitly choose.
  it("applies an explicit visibility on republish even though the skill already exists", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    const putWithVisibility = (md: string, visibility: string) =>
      putSkill(token, md, { visibility });
    await putWithVisibility(GOOD_MD, "public");
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");

    const res = await putWithVisibility(`${GOOD_MD}\nrepublish\n`, "private");
    expect(res.status).toBe(201);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  // Omitting `?visibility` entirely on a republish must mean "not supplied",
  // not "supplied as private" — both cases used to collapse to the same value
  // at the call site.
  it("leaves visibility unchanged when an API republish omits ?visibility", async () => {
    const { token } = await seedAndToken({ username: "alice" });
    await putSkill(token, GOOD_MD, { visibility: "public" });
    const res = await putSkill(token, `${GOOD_MD}\nno visibility param this time\n`);
    expect(res.status).toBe(201);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  // A failed/missing R2 object for the current latest
  // version must be self-healed by republishing identical bytes, not
  // masked forever behind `{ unchanged: true }`. Simulates the failure by
  // deleting the R2 object directly, the same way an interrupted
  // `BUCKET.put` (R2 error, isolate killed at the CPU/memory limit) would
  // leave things.
  it("repairs a missing R2 object when republishing identical bytes", async () => {
    const { cookie, token } = await seedAndToken({ username: "alice" });
    const put = () => putSkill(token, GOOD_MD);

    const first = await put();
    expect(first.status).toBe(201);
    const { version } = await first.json<{ version: number }>();
    const versionRow = await getVersion(env.DB, "demo-skill", version);
    expect(versionRow).not.toBeNull();
    await env.BUCKET.delete(versionRow!.r2_key);
    expect(await env.BUCKET.get(versionRow!.r2_key)).toBeNull();

    const second = await put();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ unchanged: true });

    const repaired = await env.BUCKET.get(versionRow!.r2_key);
    expect(repaired).not.toBeNull();

    const download = await SELF.fetch(`${ORIGIN}/s/demo-skill/download`, { headers: { Cookie: cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/zip");
  });

  // `versions.author_id` must record
  // who actually published a version, not who owns the skill — otherwise
  // the column is just a copy of `skills.owner_id` and can never show that
  // an admin published on someone else's behalf. Ownership itself must
  // stay put: `insertVersion`'s ON CONFLICT clause never touches owner_id.
  it("records the publisher as version author_id while leaving skill ownership untouched", async () => {
    const member = await seedAndToken({ username: "carol", role: "member" });
    const memberToken = member.token;
    await putSkill(memberToken, GOOD_MD);

    const admin = await seedAndToken({ username: "root-admin", role: "admin" });
    const adminToken = admin.token;
    const res = await putSkill(adminToken, `${GOOD_MD}\nadmin republish\n`);
    expect(res.status).toBe(201);
    const body = await res.json<{ version: number }>();
    expect(body.version).toBe(2);

    const skill = await getSkill(env.DB, "demo-skill");
    expect(skill?.owner_id).toBe(member.user.id);

    const version = await getVersion(env.DB, "demo-skill", 2);
    expect(version?.author_id).toBe(admin.user.id);
  });
});

describe("POST /new", () => {
  beforeEach(resetDb);

  it("publishes an uploaded file", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await postMultipart("/new", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
      visibility: "public",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/s/demo-skill");
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  it("publishes pasted markdown", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "private" });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("re-renders the form with the reason on failure", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await postMultipart("/new", cookie, {
      markdown: "---\nname: Bad_Name\ndescription: x\n---\nbody",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("name");
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
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");

    const res = await postMultipart("/new", cookie, {
      markdown: `${GOOD_MD}\nrepublished\n`,
      visibility: "private",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("keeps visibility=public on republish through /new when selected again", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });

    await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "public" });

    const res = await postMultipart("/new", cookie, {
      markdown: `${GOOD_MD}\nrepublished again\n`,
      visibility: "public",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });
});

describe("POST /s/:slug/edit", () => {
  beforeEach(resetDb);

  it("saves edited markdown as a new version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const res = await postMultipart("/s/demo-skill/edit", cookie, {
      markdown: `${GOOD_MD}\nedited\n`,
    });
    expect(res.status).toBe(302);
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(2);
  });

  // The edit path must never pass a visibility at all, so a public skill
  // stays public across an edit-triggered republish. This side always
  // behaved correctly but had no test pinning it.
  it("does not change visibility when republishing through the edit path", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "public" });

    const res = await postMultipart("/s/demo-skill/edit", cookie, {
      markdown: `${GOOD_MD}\nedited\n`,
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  // 只改文本时，旧版本里 references/ 和 scripts/ 下的文件必须原样带到新版本。
  // 此前它们会被静默丢掉：文本框内容被当成整个上传体，normalizeUpload 把一段
  // 裸 markdown 理解成「只含 SKILL.md 的 skill」，而页面返回的是 302 成功。
  it("carries SKILL.md's sibling files into the new version on a text-only edit", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });
    const v1 = await getVersion(env.DB, "demo-skill", 1);

    const res = await postMultipart("/s/demo-skill/edit", cookie, {
      markdown: `${v1!.skill_md}\nedited\n`,
    });
    expect(res.status).toBe(302);

    const v2 = await getVersion(env.DB, "demo-skill", 2);
    expect(v2!.skill_md).toContain("edited");
    expect(JSON.parse(v2!.files).map((f: { path: string }) => f.path)).toEqual([
      "SKILL.md",
      "references/api.md",
      "scripts/run.sh",
    ]);
  });

  // D1 里的 files 列对了不等于 R2 里的包对了——装 skill 的人拿到的是 R2 那份。
  it("writes the carried files into the stored artifact too", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });
    const v1 = await getVersion(env.DB, "demo-skill", 1);

    await postMultipart("/s/demo-skill/edit", cookie, { markdown: `${v1!.skill_md}\nedited\n` });

    const v2 = await getVersion(env.DB, "demo-skill", 2);
    const object = await env.BUCKET.get(v2!.r2_key);
    expect(object).not.toBeNull();
    const unpacked = await readZip(new Uint8Array(await object!.arrayBuffer()));
    expect([...unpacked.keys()].sort()).toEqual([
      "SKILL.md",
      "references/api.md",
      "scripts/run.sh",
    ]);
    expect(new TextDecoder().decode(unpacked.get("SKILL.md")!)).toContain("edited");
  });

  // 上一版的包读不出来时，宁可挡住也不要发一个悄悄少了文件的新版本。
  it("refuses a text-only edit when the current archive is missing from storage", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });
    const v1 = await getVersion(env.DB, "demo-skill", 1);
    await env.BUCKET.delete(v1!.r2_key);

    const res = await postMultipart("/s/demo-skill/edit", cookie, {
      markdown: `${v1!.skill_md}\nedited\n`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("上传压缩包");
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(1);
  });

  it("names the files a text-only edit will carry forward", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });

    const html = await (
      await SELF.fetch(`${ORIGIN}/s/demo-skill/edit`, { headers: { Cookie: cookie } })
    ).text();
    expect(html).toContain("references/api.md");
    expect(html).toContain("scripts/run.sh");
  });
});

describe("POST /s/:slug/upload", () => {
  beforeEach(resetDb);

  it("publishes an uploaded archive as a new version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const res = await postMultipart("/s/demo-skill/upload", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/s/demo-skill");

    const v2 = await getVersion(env.DB, "demo-skill", 2);
    expect(JSON.parse(v2!.files).map((f: { path: string }) => f.path)).toEqual([
      "SKILL.md",
      "references/api.md",
      "scripts/run.sh",
    ]);
  });

  it("rejects an archive whose name disagrees with the slug", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const res = await postMultipart("/s/demo-skill/upload", cookie, {
      file: new File([OTHER_MD], "SKILL.md", { type: "text/markdown" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("other-skill");
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(1);
  });

  it("re-renders the page when no file was chosen", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const res = await postMultipart("/s/demo-skill/upload", cookie, {});
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("压缩包");
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(1);
  });

  it("keeps a public skill public", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD, visibility: "public" });

    const res = await postMultipart("/s/demo-skill/upload", cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  it("stops a member updating another user's skill", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", alice.cookie, { markdown: GOOD_MD });

    const bob = await seedAndLogin({ username: "bob", role: "member" });
    const res = await postMultipart("/s/demo-skill/upload", bob.cookie, {
      file: new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }),
    });
    expect(res.status).toBe(403);
  });
});

// 编辑和上传是两条独立的路，各自只有一种输入。这两条钉住的是页面形状本身：
// 一旦有人把文件框搬回编辑页，「两个都填了听谁的」那条规则就会跟着回来。
describe("编辑与上传各自只有一种输入", () => {
  beforeEach(resetDb);

  it("keeps the edit page free of a file input", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const html = await (
      await SELF.fetch(`${ORIGIN}/s/demo-skill/edit`, { headers: { Cookie: cookie } })
    ).text();
    expect(html).toContain("<textarea");
    expect(html).not.toContain('type="file"');
  });

  it("keeps the upload page free of a markdown textarea", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await postMultipart("/new", cookie, { markdown: GOOD_MD });

    const html = await (
      await SELF.fetch(`${ORIGIN}/s/demo-skill/upload`, { headers: { Cookie: cookie } })
    ).text();
    expect(html).toContain('type="file"');
    expect(html).not.toContain("<textarea");
  });
});
