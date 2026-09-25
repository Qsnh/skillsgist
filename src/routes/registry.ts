import { Hono } from "hono";
import { digestFromArtifactFile } from "../artifact";
import type { AppEnv, Ctx } from "../auth";
import {
  getArtifactByDigest, getMembershipByInstallKey, getPublicArtifact, listPublishedForIndex,
} from "../db/queries";
import type { ArtifactRef, IndexFilter } from "../db/queries";
import { buildIndex } from "../registry";
import { serveDownload } from "./download";

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

async function sendArtifact(c: Ctx, artifact: ArtifactRef | null, cacheable: boolean): Promise<Response> {
  if (!artifact) return notFound();
  const object = await c.env.BUCKET.get(artifact.r2_key);
  if (!object) return notFound();
  return serveDownload(c, object, artifact, cacheable);
}

// Each index path minus its trailing `/index.json`, used to register the
// nested wildcard routes.
const INDEX_PREFIXES = INDEX_SUFFIXES.map((suffix) => suffix.slice(0, -"/index.json".length));

const SKILL_IN_PATH = /\/\.well-known\/(?:agent-skills|skills)\/([^/]+)$/;

type IndexScope = { kind: "root" } | { kind: "project"; project: string } | { kind: "key"; key: string };

interface IndexRequest {
  scope: IndexScope;
  only: string | null;
}

function indexRequest(path: string): IndexRequest | null {
  const suffix = INDEX_SUFFIXES.find((s) => path.endsWith(s));
  if (!suffix) return null;
  const base = path.slice(0, path.length - suffix.length);
  const key = /^\/i\/([^/]+)/.exec(base)?.[1];
  const project = /^\/p\/([^/]+)/.exec(base)?.[1];
  return {
    scope: key ? { kind: "key", key } : project ? { kind: "project", project } : { kind: "root" },
    only: SKILL_IN_PATH.exec(base)?.[1] ?? null,
  };
}

async function serveIndex(c: Ctx, req: IndexRequest): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  let base = origin;
  let filter: IndexFilter = { kind: "root" };
  if (req.scope.kind === "key") {
    const membership = await getMembershipByInstallKey(c.env.DB, req.scope.key);
    if (!membership) return notFound();
    base = `${origin}/i/${req.scope.key}`;
    filter = { kind: "project", project: membership.project, publicOnly: false };
  }
  if (req.scope.kind === "project") {
    base = `${origin}/p/${req.scope.project}`;
    filter = { kind: "project", project: req.scope.project, publicOnly: true };
  }
  const rows = await listPublishedForIndex(c.env.DB, filter);
  return indexResponse(buildIndex(req.only ? rows.filter((r) => r.slug === req.only) : rows, base));
}

const indexRoute = (c: Ctx) => {
  const req = indexRequest(c.req.path);
  return req ? serveIndex(c, req) : notFound();
};

for (const suffix of INDEX_SUFFIXES) {
  registryRoutes.get(suffix, indexRoute);
  registryRoutes.get(`/p/:project${suffix}`, indexRoute);
}

registryRoutes.get("/d/:slug/:file", async (c) => {
  const digest = digestFromArtifactFile(c.req.param("file"));
  const artifact = digest ? await getPublicArtifact(c.env.DB, c.req.param("slug"), digest) : null;
  return sendArtifact(c, artifact, true);
});

registryRoutes.get("/p/:project/d/:slug/:file", async (c) => {
  const digest = digestFromArtifactFile(c.req.param("file"));
  const artifact = digest
    ? await getArtifactByDigest(c.env.DB, c.req.param("project"), c.req.param("slug"), digest)
    : null;
  return sendArtifact(c, artifact?.visibility === "public" ? artifact : null, true);
});

registryRoutes.get("/i/:key/d/:slug/:file", async (c) => {
  const membership = await getMembershipByInstallKey(c.env.DB, c.req.param("key"));
  if (!membership) return c.notFound();
  const digest = digestFromArtifactFile(c.req.param("file"));
  const artifact = digest
    ? await getArtifactByDigest(c.env.DB, membership.project, c.req.param("slug"), digest)
    : null;
  return sendArtifact(c, artifact, false);
});

for (const prefix of INDEX_PREFIXES) {
  registryRoutes.get(`${prefix}/*`, indexRoute);
  registryRoutes.get(`/p/:project${prefix}/*`, indexRoute);
}

registryRoutes.get("/i/:key/*", indexRoute);
