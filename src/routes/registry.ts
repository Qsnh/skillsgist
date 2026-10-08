import { Hono } from "hono";
import { digestFromArtifactFile } from "../artifact";
import type { AppEnv, Ctx } from "../auth";
import { bearerAccess, PRIVATE_HEADERS, privateNotFound, projectGate } from "../bearer";
import { getArtifactByDigest, getPublicArtifact, listPublishedForIndex } from "../db/queries";
import type { ArtifactRef, IndexFilter } from "../db/queries";
import { projectPath } from "../paths";
import { buildIndex } from "../registry";
import { serveDownload } from "./download";

export const registryRoutes = new Hono<AppEnv>();

const INDEX_SUFFIXES = [
  "/.well-known/agent-skills/index.json",
  "/.well-known/skills/index.json",
];

const notFound = () => new Response("not found", { status: 404 });

function indexResponse(body: unknown, headers: Record<string, string> = { "Cache-Control": "no-cache" }): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function sendArtifact(
  c: Ctx,
  file: string,
  lookup: (digest: string) => Promise<ArtifactRef | null>,
): Promise<Response> {
  const digest = digestFromArtifactFile(file);
  const artifact = digest ? await lookup(digest) : null;
  if (!artifact) return notFound();
  const object = await c.env.BUCKET.get(artifact.r2_key);
  if (!object) return notFound();
  return serveDownload(c, object, artifact, true);
}

// Each index path minus its trailing `/index.json`, used to register the
// nested wildcard routes.
const INDEX_PREFIXES = INDEX_SUFFIXES.map((suffix) => suffix.slice(0, -"/index.json".length));

const SKILL_IN_PATH = /\/\.well-known\/(?:agent-skills|skills)\/([^/]+)$/;

type IndexScope = { kind: "root" } | { kind: "project"; project: string };

interface IndexRequest {
  scope: IndexScope;
  only: string | null;
}

function indexRequest(path: string): IndexRequest | null {
  const suffix = INDEX_SUFFIXES.find((s) => path.endsWith(s));
  if (!suffix) return null;
  const base = path.slice(0, path.length - suffix.length);
  const project = /^\/p\/([^/]+)/.exec(base)?.[1];
  return {
    scope: project ? { kind: "project", project } : { kind: "root" },
    only: SKILL_IN_PATH.exec(base)?.[1] ?? null,
  };
}

async function serveIndex(c: Ctx, req: IndexRequest): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  if (req.scope.kind === "root") {
    return indexResponse(buildIndex(await listPublishedForIndex(c.env.DB, { kind: "root" }, req.only), origin));
  }
  const gate = projectGate(await bearerAccess(c), req.scope.project);
  if (gate.kind === "refuse") return gate.response;
  const filter: IndexFilter = { kind: "project", project: req.scope.project, publicOnly: gate.kind === "public" };
  return indexResponse(
    buildIndex(await listPublishedForIndex(c.env.DB, filter, req.only), `${origin}${projectPath(req.scope.project)}`),
    PRIVATE_HEADERS,
  );
}

const indexRoute = (c: Ctx) => {
  const req = indexRequest(c.req.path);
  return req ? serveIndex(c, req) : notFound();
};

for (const suffix of INDEX_SUFFIXES) {
  registryRoutes.get(suffix, indexRoute);
  registryRoutes.get(`/p/:project${suffix}`, indexRoute);
}

registryRoutes.get("/d/:slug/:file", (c) =>
  sendArtifact(c, c.req.param("file"), (digest) => getPublicArtifact(c.env.DB, c.req.param("slug"), digest)),
);

registryRoutes.get("/p/:project/d/:slug/:file", async (c) => {
  const project = c.req.param("project");
  const gate = projectGate(await bearerAccess(c), project);
  if (gate.kind === "refuse") return gate.response;
  const digest = digestFromArtifactFile(c.req.param("file"));
  const artifact = digest ? await getArtifactByDigest(c.env.DB, project, c.req.param("slug"), digest) : null;
  if (!artifact || (artifact.visibility !== "public" && gate.kind !== "all")) return privateNotFound();
  const object = await c.env.BUCKET.get(artifact.r2_key);
  if (!object) return privateNotFound();
  const cacheable = artifact.visibility === "public";
  const res = serveDownload(c, object, artifact, cacheable);
  if (!cacheable) res.headers.set("Vary", "Authorization");
  return res;
});

for (const prefix of INDEX_PREFIXES) {
  registryRoutes.get(`${prefix}/*`, indexRoute);
  registryRoutes.get(`/p/:project${prefix}/*`, indexRoute);
}
