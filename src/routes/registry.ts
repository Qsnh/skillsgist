import { Hono } from "hono";
import { digestFromArtifactFile, zipAttachment } from "../artifact";
import type { AppEnv } from "../auth";
import { getArtifactByDigest, getUserByInstallKey, listPublishedForIndex } from "../db/queries";
import { buildIndex } from "../registry";
import type { Env } from "../types";

export const registryRoutes = new Hono<AppEnv>();

const INDEX_SUFFIXES = [
  "/.well-known/agent-skills/index.json",
  "/.well-known/skills/index.json",
];

const notFound = () => new Response("not found", { status: 404 });

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
  const digest = digestFromArtifactFile(file);
  if (!digest) return notFound();

  const artifact = await getArtifactByDigest(env.DB, slug, digest);
  if (!artifact) return notFound();
  if (visible === "public" && artifact.visibility !== "public") return notFound();

  const object = await env.BUCKET.get(artifact.r2_key);
  if (!object) return notFound();

  return zipAttachment(object, slug, visible === "public");
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
  const key = c.req.param("key");
  if (!INDEX_SUFFIXES.some((suffix) => c.req.path.endsWith(suffix))) return c.notFound();
  const user = await getUserByInstallKey(c.env.DB, key);
  if (!user) return c.notFound();
  const rows = await listPublishedForIndex(c.env.DB, true);
  return indexResponse(buildIndex(rows, `${new URL(c.req.url).origin}/i/${key}`));
});
