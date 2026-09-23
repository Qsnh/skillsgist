import { Hono } from "hono";
import { digestFromArtifactFile, zipAttachment } from "../artifact";
import type { AppEnv, Ctx } from "../auth";
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

// Each index path minus its trailing `/index.json`, used to register the
// nested wildcard routes.
const INDEX_PREFIXES = INDEX_SUFFIXES.map((suffix) => suffix.slice(0, -"/index.json".length));

// Mirrors the shape the CLI uses to recognise a skill name (the
// WellKnownProvider in skills 1.5.18), so the address shown on /s/:slug means
// the same skill to the server and to the CLI.
const SKILL_IN_PATH = /\/\.well-known\/(?:agent-skills|skills)\/([^/]+)$/;

/** The two variables in an install address: install key (optional) and skill name (optional). */
interface IndexRequest {
  key: string | null;
  only: string | null;
}

function indexRequest(path: string): IndexRequest | null {
  const suffix = INDEX_SUFFIXES.find((s) => path.endsWith(s));
  if (!suffix) return null;
  const base = path.slice(0, path.length - suffix.length);
  return {
    key: /^\/i\/([^/]+)/.exec(base)?.[1] ?? null,
    only: SKILL_IN_PATH.exec(base)?.[1] ?? null,
  };
}

async function serveIndex(c: Ctx, req: IndexRequest): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  let base = origin;
  if (req.key !== null) {
    if (!(await getUserByInstallKey(c.env.DB, req.key))) return notFound();
    base = `${origin}/i/${req.key}`;
  }
  const rows = await listPublishedForIndex(c.env.DB, req.key !== null);
  return indexResponse(buildIndex(req.only ? rows.filter((r) => r.slug === req.only) : rows, base));
}

const indexRoute = (c: Ctx) => {
  const req = indexRequest(c.req.path);
  return req ? serveIndex(c, req) : notFound();
};

for (const suffix of INDEX_SUFFIXES) {
  registryRoutes.get(suffix, indexRoute);
}

registryRoutes.get("/d/:slug/:file", async (c) =>
  serveArtifact(c.env, c.req.param("slug"), c.req.param("file"), "public"),
);

registryRoutes.get("/i/:key/d/:slug/:file", async (c) => {
  const user = await getUserByInstallKey(c.env.DB, c.req.param("key"));
  if (!user) return c.notFound();
  return serveArtifact(c.env, c.req.param("slug"), c.req.param("file"), "any");
});

for (const prefix of INDEX_PREFIXES) {
  registryRoutes.get(`${prefix}/*`, indexRoute);
}

registryRoutes.get("/i/:key/*", indexRoute);
