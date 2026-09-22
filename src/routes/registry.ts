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

// 每条 index 路径去掉 `/index.json` 之后的前缀，用来注册嵌套通配路由。
const INDEX_PREFIXES = INDEX_SUFFIXES.map((suffix) => suffix.slice(0, -"/index.json".length));

// 照抄 CLI 认 skill 名用的形状（skills 1.5.18 的 WellKnownProvider），好让
// /s/:slug 展示的地址在服务端和 CLI 眼里指的是同一个 skill。
const SKILL_IN_PATH = /\/\.well-known\/(?:agent-skills|skills)\/([^/]+)$/;

/** 安装地址里的两个变量：install key（可选）与 skill 名（可选）。 */
interface IndexRequest {
  key: string | null;
  only: string | null;
}

/**
 * 把一条 index 路径拆成 `IndexRequest`，不是 index 路径则返回 null。
 *
 * CLI 把整条安装 URL 当作 basePath，再往后拼 `/.well-known/<ns>/index.json`，
 * 所以「这是哪一种 index 请求」全写在 basePath 里：`/i/<key>` 前缀决定可见范围，
 * `.well-known/<ns>/<slug>` 后缀决定只要哪一个 skill。两者都从同一次解析里取，
 * 匿名和带 key 两条路径就不可能再各自漂移。
 */
function indexRequest(path: string): IndexRequest | null {
  const suffix = INDEX_SUFFIXES.find((s) => path.endsWith(s));
  if (!suffix) return null;
  const base = path.slice(0, path.length - suffix.length);
  return {
    key: /^\/i\/([^/]+)/.exec(base)?.[1] ?? null,
    only: SKILL_IN_PATH.exec(base)?.[1] ?? null,
  };
}

/**
 * 发现 index。
 *
 * `only` 非空时只返回那一个 skill —— 这是 per-skill 安装地址能成立的全部原因：
 * `skills add` 走 fetchAllSkills()，它返回 index 里的全部条目、从不看路径里的
 * slug，只有当 index 恰好只剩一条时才会自动选中它。不收窄的话，一个「装这一个」
 * 的地址会把全部 skill 都装上。
 */
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

// 接住 `indexRequest` 说的那层嵌套：每种安装地址后面都要有一条通配。三条共用字面
// 同一个 handler —— 匿名与带 key 曾是两段各写各的代码，结果只有带 key 那段补了
// 兜底，匿名那条展示出来却没人接。
for (const prefix of INDEX_PREFIXES) {
  registryRoutes.get(`${prefix}/*`, indexRoute);
}

registryRoutes.get("/i/:key/*", indexRoute);
