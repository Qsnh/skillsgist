import { Hono } from "hono";
import { getSkill, getUserByInstallKey, getVersionByDigest, listPublishedForIndex } from "../db/queries";
import { buildIndex } from "../registry";
import type { Env } from "../types";

export const registryRoutes = new Hono<{ Bindings: Env }>();

const INDEX_SUFFIXES = [
  "/.well-known/agent-skills/index.json",
  "/.well-known/skills/index.json",
];

function indexResponse(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
  });
}

async function serveArtifact(
  env: Env,
  slug: string,
  file: string,
  visible: "public" | "any",
): Promise<Response> {
  const match = /^([a-f0-9]{64})\.zip$/.exec(file);
  if (!match) return new Response("not found", { status: 404 });

  const skill = await getSkill(env.DB, slug);
  if (!skill) return new Response("not found", { status: 404 });
  if (visible === "public" && skill.visibility !== "public") {
    return new Response("not found", { status: 404 });
  }

  const version = await getVersionByDigest(env.DB, slug, `sha256:${match[1]}`);
  if (!version) return new Response("not found", { status: 404 });

  const object = await env.BUCKET.get(version.r2_key);
  if (!object) return new Response("not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Cache-Control": visible === "public" ? "public, max-age=300" : "private, no-store",
    },
  });
}

for (const suffix of INDEX_SUFFIXES) {
  registryRoutes.get(suffix, async (c) => {
    const rows = await listPublishedForIndex(c.env.DB, false);
    return indexResponse(buildIndex(rows, new URL(c.req.url).origin));
  });
}

registryRoutes.get("/d/:slug/:file", async (c) =>
  serveArtifact(c.env, c.req.param("slug"), c.req.param("file"), "public"),
);

registryRoutes.get("/i/:key/d/:slug/:file", async (c) => {
  const user = await getUserByInstallKey(c.env.DB, c.req.param("key"));
  if (!user) return c.notFound();
  return serveArtifact(c.env, c.req.param("slug"), c.req.param("file"), "any");
});

// CLI 装单个私有 skill 时会把整条 URL 当作 basePath 再拼一次 .well-known，
// 所以这里用通配接住任意深度的嵌套，统一返回该 key 可见的 index。
registryRoutes.get("/i/:key/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const key = c.req.param("key");
  if (!INDEX_SUFFIXES.some((suffix) => path.endsWith(suffix))) return c.notFound();
  const user = await getUserByInstallKey(c.env.DB, key);
  if (!user) return c.notFound();
  const rows = await listPublishedForIndex(c.env.DB, true);
  return indexResponse(buildIndex(rows, `${new URL(c.req.url).origin}/i/${key}`));
});
