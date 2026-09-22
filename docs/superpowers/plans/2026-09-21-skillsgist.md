# skillsgist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cloudflare Workers 上实现一个极简的私有 Agent Skills registry，提供网页管理与下载，并兼容 `npx skills`（skills.sh）的一键安装协议。

**Architecture:** 单个 Worker 用 Hono 承担全部职责：hono/jsx 服务端渲染网页、生成 `.well-known/agent-skills/index.json`、分发 zip 产物、接收上传。元数据与渲染后的 HTML 存 D1，规范化后的 zip 字节存 R2，Tailwind 构建产物由 Workers Assets 托管。核心不变式是「R2 里的字节 == 网页下载的字节 == index.json 里 digest 对应的字节」。

**Tech Stack:** Cloudflare Workers、Hono（含 hono/jsx）、D1、R2、Workers Assets、Tailwind v4、TypeScript、Vitest + @cloudflare/vitest-pool-workers。运行时依赖只有 `hono`、`marked`、`yaml`。

**Spec:** `docs/superpowers/specs/2026-09-21-skillsgist-design.md`

## Global Constraints

以下数值全部逐字来自 spec，每个任务的要求都隐含包含本节。

- **skill name 规则**：`^[a-z0-9-]+$`，长度 1–64，不以 `-` 开头或结尾，不含 `--`
- **description 规则**：非空字符串，长度 ≤ 1024
- **digest 格式**：`^sha256:[a-f0-9]{64}$`，且必须等于产物字节的实际 SHA-256
- **压缩包约束**：根目录必须有 `SKILL.md`；路径不得以 `/` 或盘符开头，不得含 `\`、`..`、`.`、NUL；不接受软链接与硬链接条目；zip 只用压缩方法 0 与 8
- **上传限额**：上传 ≤ 2 MB，解包后 ≤ 8 MB，文件数 ≤ 200
- **密码**：PBKDF2-HMAC-SHA256，迭代数 10,000，salt 16 字节，派生 32 字节；密码长度强制 ≥ 12 字符
- **CPU 预算**：Workers Free 单次请求 10 ms。压缩解压一律使用原生 `CompressionStream` / `DecompressionStream`（`gzip`、`deflate`、`deflate-raw`），禁止引入 JS 实现的 inflate/deflate 到运行时代码；markdown 渲染只在发布时进行并把 HTML 存库
- **缓存头**：公开产物 `Cache-Control: public, max-age=300`；私有产物 `Cache-Control: private, no-store`；index.json `Cache-Control: no-cache`。**不得对产物使用 `immutable` 或长 `max-age`**
- **运行时依赖白名单**：`hono`、`marked`、`yaml`。不得新增运行时依赖。`fflate` 只能作为 devDependency 在测试中充当独立参照实现
- **无效凭据一律返回 404**，不返回 401，避免泄露凭据是否存在
- **index.json 生成失败时返回 5xx，绝不返回空的 `skills` 数组**（CLI 会把空数组当成"registry 是空的"）

## File Structure

```
src/
  index.ts              Hono app 与路由装配；唯一的 export default
  auth.ts               密码哈希、会话 cookie、install_key / api_token 校验、角色判定
  registry.ts           index.json 的构建与自检（纯函数，不碰 HTTP）
  publish.ts            发布核心 publishBytes（不碰 HTTP）
  routes/users.tsx      setup / login / logout / me / admin·users
  routes/publish.tsx    /new、/s/:slug/edit、PUT /api/skills/:slug
  routes/registry.ts    .well-known index 与产物下载
  routes/skills.tsx     列表、详情、下载、可见性、删除
  skills/normalize.ts   格式识别 → 解包 → 路径清洗 → 校验 → 重打包 → digest
  skills/zip.ts         zip 读与写（含 crc32）
  skills/tar.ts         tar.gz 读
  skills/frontmatter.ts frontmatter 解析与 name/description 校验
  render/markdown.ts    marked 渲染 + HTMLRewriter 净化
  views/layout.tsx      页面骨架
  views/pages.tsx       各页面组件
  db/queries.ts         全部 D1 访问，其他模块不直接写 SQL
  types.ts              Env 与共享类型
  app.css               Tailwind 入口
migrations/
  0001_init.sql
public/app.css          Tailwind 构建产物（git 忽略）
test/
  fixtures/             真实 zip / tar.gz 测试数据
  helpers.ts            建用户、发布 skill 等测试辅助
scripts/
  make-fixtures.sh      用系统 tar/zip 生成 fixtures
  verify-cli.mjs        真实 npx skills 契约测试
wrangler.jsonc
vitest.config.ts
```

每个文件一个职责。`db/queries.ts` 是唯一写 SQL 的地方；`skills/` 下三个文件只做字节处理、不碰 HTTP 与数据库；`views/` 只渲染、不查库。

---

### Task 1: 项目脚手架与测试基础设施

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts`, `src/types.ts`, `migrations/0001_init.sql`, `test/setup.ts`, `.gitignore`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `src/types.ts` 导出 `interface Env { DB: D1Database; BUCKET: R2Bucket; ASSETS: Fetcher; SESSION_SECRET: string }`；`src/index.ts` 默认导出 Hono app

- [ ] **Step 1: 初始化 package.json 与依赖**

```bash
cd /Users/tengyongzhi/work/bot-workspaces/skillsgist
npm init -y
npm pkg set name=skillsgist private=true type=module
npm install hono marked yaml
npm install -D wrangler typescript vitest @cloudflare/vitest-pool-workers tailwindcss @tailwindcss/cli concurrently fflate @types/node
```

- [ ] **Step 2: 写配置文件**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types/experimental", "@cloudflare/vitest-pool-workers"],
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*", "test/**/*", "vitest.config.ts"]
}
```

`wrangler.jsonc`：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "skillsgist",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  // nodejs_compat 是 @cloudflare/vitest-pool-workers 的硬性要求
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "skillsgist",
      "database_id": "local-dev-placeholder",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "skillsgist" }]
}
```

`database_id` 现在填占位值即可；Task 13 部署时用 `wrangler d1 create skillsgist` 的真实输出替换。本地测试与 `wrangler dev` 都不读这个值。

`.gitignore`：

```
node_modules/
public/app.css
.wrangler/
dist/
```

`public/` 目录必须存在（Workers Assets 的 `directory` 指向它），而构建产物被忽略，所以放一个占位文件：

```bash
mkdir -p public && touch public/.gitkeep
```

- [ ] **Step 3: 写 vitest 配置与 migrations 应用**

`vitest.config.ts`：

```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations, SESSION_SECRET: "test-secret" },
          },
        },
      },
    },
  };
});
```

`test/setup.ts`：

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
```

- [ ] **Step 4: 写空 migration 与 Env 类型**

`migrations/0001_init.sql` 先只放一行占位注释，Task 2 填内容：

```sql
-- schema 在 Task 2 填充
SELECT 1;
```

`src/types.ts`：

```ts
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
}
```

- [ ] **Step 5: 写失败的冒烟测试**

`test/smoke.test.ts`：

```ts
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds on /healthz", async () => {
  const res = await SELF.fetch("http://localhost/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
```

- [ ] **Step 6: 运行测试确认失败**

```bash
npx vitest run test/smoke.test.ts
```

预期：失败，因为 `src/index.ts` 还不存在。

- [ ] **Step 7: 写最小实现**

`src/index.ts`：

```ts
import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));

export default app;
```

- [ ] **Step 8: 运行测试确认通过**

```bash
npx vitest run test/smoke.test.ts
```

预期：1 passed。

- [ ] **Step 9: 加 npm scripts 并提交**

```bash
npm pkg set scripts.dev="concurrently \"npx @tailwindcss/cli -i src/app.css -o public/app.css --watch\" \"wrangler dev\""
npm pkg set scripts.build="npx @tailwindcss/cli -i src/app.css -o public/app.css --minify"
npm pkg set scripts.deploy="npm run build && wrangler deploy"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
git add -A
git commit -m "chore: scaffold worker, vitest pool-workers, d1/r2 bindings"
```

---

### Task 2: D1 schema 与查询层

**Files:**
- Modify: `migrations/0001_init.sql`
- Create: `src/db/queries.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Env`
- Produces:
  - `interface UserRow { id: string; username: string; password_hash: string; role: "admin" | "member"; install_key: string; api_token_hash: string | null; created_at: number; last_login_at: number | null }`
  - `interface SkillRow { slug: string; description: string; visibility: "public" | "private"; owner_id: string; latest_version: number; created_at: number; updated_at: number }`
  - `interface VersionRow { slug: string; version: number; digest: string; size: number; name: string; description: string; skill_md: string; html: string; files: string; r2_key: string; author_id: string; created_at: number }`
  - `countUsers(db: D1Database): Promise<number>`
  - `createUser(db, input: { id: string; username: string; passwordHash: string; role: "admin" | "member"; installKey: string }): Promise<void>`
  - `getUserByUsername(db, username: string): Promise<UserRow | null>`
  - `getUserById(db, id: string): Promise<UserRow | null>`
  - `getUserByInstallKey(db, key: string): Promise<UserRow | null>`
  - `listUsers(db): Promise<UserRow[]>`
  - `listSkills(db, opts: { includePrivate: boolean; q?: string }): Promise<Array<SkillRow & { author: string }>>`
  - `getSkill(db, slug: string): Promise<SkillRow | null>`
  - `getVersion(db, slug: string, version: number): Promise<VersionRow | null>`
  - `listVersions(db, slug: string): Promise<VersionRow[]>`
  - `listPublishedForIndex(db, includePrivate: boolean): Promise<Array<{ slug: string; description: string; digest: string }>>`
  - `insertVersion(db, input: InsertVersionInput): Promise<number>` 返回新版本号
  - `setVisibility(db, slug: string, visibility: "public" | "private"): Promise<void>`
  - `deleteSkill(db, slug: string): Promise<string[]>` 返回被删除版本的全部 r2_key
  - `updateInstallKey(db, userId: string, key: string): Promise<void>`
  - `updateApiTokenHash(db, userId: string, hash: string | null): Promise<void>`
  - `updatePassword(db, userId: string, hash: string): Promise<void>`
  - `touchLogin(db, userId: string, at: number): Promise<void>`

- [ ] **Step 1: 写失败的测试**

`test/db.test.ts`：

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries";

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM versions"),
    env.DB.prepare("DELETE FROM skills"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

const base = {
  digest: "sha256:" + "a".repeat(64),
  size: 100,
  name: "demo",
  description: "a demo skill",
  skill_md: "---\nname: demo\ndescription: a demo skill\n---\nbody",
  html: "<p>body</p>",
  files: JSON.stringify([{ path: "SKILL.md", size: 10 }]),
};

describe("queries", () => {
  beforeEach(reset);

  it("counts users and round-trips one", async () => {
    expect(await q.countUsers(env.DB)).toBe(0);
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    expect(await q.countUsers(env.DB)).toBe(1);
    const byName = await q.getUserByUsername(env.DB, "alice");
    expect(byName?.id).toBe("u1");
    expect(await q.getUserByInstallKey(env.DB, "k1")).not.toBeNull();
    expect(await q.getUserByInstallKey(env.DB, "nope")).toBeNull();
  });

  it("allocates version numbers monotonically per slug", async () => {
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    const v1 = await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
    });
    const v2 = await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
      digest: "sha256:" + "b".repeat(64),
    });
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    const skill = await q.getSkill(env.DB, "demo");
    expect(skill?.latest_version).toBe(2);
    expect(await q.listVersions(env.DB, "demo")).toHaveLength(2);
  });

  it("hides private skills from the public index", async () => {
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    await q.insertVersion(env.DB, { ...base, slug: "secret", authorId: "u1", visibility: "private" });
    await q.insertVersion(env.DB, {
      ...base, slug: "shared", authorId: "u1", visibility: "public",
      digest: "sha256:" + "c".repeat(64),
    });
    const pub = await q.listPublishedForIndex(env.DB, false);
    expect(pub.map((s) => s.slug)).toEqual(["shared"]);
    const all = await q.listPublishedForIndex(env.DB, true);
    expect(all.map((s) => s.slug).sort()).toEqual(["secret", "shared"]);
  });

  it("returns r2 keys when deleting a skill", async () => {
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    const keys = await q.deleteSkill(env.DB, "demo");
    expect(keys).toEqual(["skills/demo/1.zip"]);
    expect(await q.getSkill(env.DB, "demo")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/db.test.ts
```

预期：失败，`src/db/queries` 不存在，且表不存在。

- [ ] **Step 3: 写 migration**

`migrations/0001_init.sql`（替换整个文件）：

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  install_key    TEXT NOT NULL UNIQUE,
  api_token_hash TEXT,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE skills (
  slug           TEXT PRIMARY KEY,
  description    TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  owner_id       TEXT NOT NULL REFERENCES users(id),
  latest_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_skills_visibility ON skills(visibility);

CREATE TABLE versions (
  slug        TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  skill_md    TEXT NOT NULL,
  html        TEXT NOT NULL,
  files       TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  author_id   TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);
```

- [ ] **Step 4: 写查询层实现**

`src/db/queries.ts`：

```ts
export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "admin" | "member";
  install_key: string;
  api_token_hash: string | null;
  created_at: number;
  last_login_at: number | null;
}

export interface SkillRow {
  slug: string;
  description: string;
  visibility: "public" | "private";
  owner_id: string;
  latest_version: number;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  slug: string;
  version: number;
  digest: string;
  size: number;
  name: string;
  description: string;
  skill_md: string;
  html: string;
  files: string;
  r2_key: string;
  author_id: string;
  created_at: number;
}

export interface InsertVersionInput {
  slug: string;
  digest: string;
  size: number;
  name: string;
  description: string;
  skill_md: string;
  html: string;
  files: string;
  authorId: string;
  visibility: "public" | "private";
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createUser(
  db: D1Database,
  input: { id: string; username: string; passwordHash: string; role: "admin" | "member"; installKey: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, install_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(input.id, input.username, input.passwordHash, input.role, input.installKey, Date.now())
    .run();
}

export function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export function getUserByInstallKey(db: D1Database, key: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE install_key = ?").bind(key).first<UserRow>();
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY created_at").all<UserRow>();
  return results;
}

export async function listSkills(
  db: D1Database,
  opts: { includePrivate: boolean; q?: string },
): Promise<Array<SkillRow & { author: string }>> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includePrivate) clauses.push("s.visibility = 'public'");
  if (opts.q) {
    clauses.push(
      "(s.slug LIKE ?1 OR s.description LIKE ?1 OR EXISTS (SELECT 1 FROM versions v WHERE v.slug = s.slug AND v.version = s.latest_version AND v.skill_md LIKE ?1))",
    );
    binds.push(`%${opts.q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT s.*, u.username AS author FROM skills s JOIN users u ON u.id = s.owner_id ${where} ORDER BY s.updated_at DESC`;
  const { results } = await db.prepare(sql).bind(...binds).all<SkillRow & { author: string }>();
  return results;
}

export function getSkill(db: D1Database, slug: string): Promise<SkillRow | null> {
  return db.prepare("SELECT * FROM skills WHERE slug = ?").bind(slug).first<SkillRow>();
}

export function getVersion(db: D1Database, slug: string, version: number): Promise<VersionRow | null> {
  return db
    .prepare("SELECT * FROM versions WHERE slug = ? AND version = ?")
    .bind(slug, version)
    .first<VersionRow>();
}

export async function listVersions(db: D1Database, slug: string): Promise<VersionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM versions WHERE slug = ? ORDER BY version DESC")
    .bind(slug)
    .all<VersionRow>();
  return results;
}

export async function listPublishedForIndex(
  db: D1Database,
  includePrivate: boolean,
): Promise<Array<{ slug: string; description: string; digest: string }>> {
  const where = includePrivate ? "" : "WHERE s.visibility = 'public'";
  const sql = `SELECT s.slug, v.description, v.digest
               FROM skills s
               JOIN versions v ON v.slug = s.slug AND v.version = s.latest_version
               ${where}
               ORDER BY s.slug`;
  const { results } = await db.prepare(sql).all<{ slug: string; description: string; digest: string }>();
  return results;
}

export async function insertVersion(db: D1Database, input: InsertVersionInput): Promise<number> {
  const now = Date.now();
  const next = await db
    .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM versions WHERE slug = ?")
    .bind(input.slug)
    .first<{ n: number }>();
  const version = next?.n ?? 1;
  const r2Key = `skills/${input.slug}/${version}.zip`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO skills (slug, description, visibility, owner_id, latest_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET description = excluded.description,
                                         latest_version = excluded.latest_version,
                                         updated_at = excluded.updated_at`,
      )
      .bind(input.slug, input.description, input.visibility, input.authorId, version, now, now),
    db
      .prepare(
        `INSERT INTO versions (slug, version, digest, size, name, description, skill_md, html, files, r2_key, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.slug, version, input.digest, input.size, input.name, input.description,
        input.skill_md, input.html, input.files, r2Key, input.authorId, now,
      ),
  ]);

  return version;
}

export async function setVisibility(
  db: D1Database,
  slug: string,
  visibility: "public" | "private",
): Promise<void> {
  await db
    .prepare("UPDATE skills SET visibility = ?, updated_at = ? WHERE slug = ?")
    .bind(visibility, Date.now(), slug)
    .run();
}

export async function deleteSkill(db: D1Database, slug: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT r2_key FROM versions WHERE slug = ?")
    .bind(slug)
    .all<{ r2_key: string }>();
  await db.batch([
    db.prepare("DELETE FROM versions WHERE slug = ?").bind(slug),
    db.prepare("DELETE FROM skills WHERE slug = ?").bind(slug),
  ]);
  return results.map((r) => r.r2_key);
}

export async function updateInstallKey(db: D1Database, userId: string, key: string): Promise<void> {
  await db.prepare("UPDATE users SET install_key = ? WHERE id = ?").bind(key, userId).run();
}

export async function updateApiTokenHash(
  db: D1Database,
  userId: string,
  hash: string | null,
): Promise<void> {
  await db.prepare("UPDATE users SET api_token_hash = ? WHERE id = ?").bind(hash, userId).run();
}

export async function updatePassword(db: D1Database, userId: string, hash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, userId).run();
}

export async function touchLogin(db: D1Database, userId: string, at: number): Promise<void> {
  await db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(at, userId).run();
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run test/db.test.ts
```

预期：4 passed。

- [ ] **Step 6: 提交**

```bash
git add migrations/0001_init.sql src/db/queries.ts test/db.test.ts
git commit -m "feat: d1 schema and query layer"
```

---

### Task 3: CRC32 与 zip 写入器

**Files:**
- Create: `src/skills/zip.ts`
- Test: `test/zip-write.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `crc32(data: Uint8Array): number`
  - `interface ArchiveEntry { path: string; data: Uint8Array }`
  - `writeZip(entries: ArchiveEntry[]): Promise<Uint8Array>` — 按路径字典序排序、固定时间戳、不写目录条目

- [ ] **Step 1: 写失败的测试**

测试用 devDependency `fflate` 作为**独立参照实现**来验证我们写出的 zip，避免"自己写自己读"的循环验证。

`test/zip-write.test.ts`：

```ts
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32, writeZip } from "../src/skills/zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("crc32", () => {
  it("matches the standard test vector", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("returns 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("writeZip", () => {
  it("produces an archive a third-party reader can open", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode("---\nname: demo\n---\nhello") },
      { path: "references/api.md", data: enc.encode("# api") },
    ]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "references/api.md"]);
    expect(dec.decode(files["SKILL.md"])).toContain("name: demo");
    expect(dec.decode(files["references/api.md"])).toBe("# api");
  });

  it("sorts entries by path so output is deterministic", async () => {
    const a = await writeZip([
      { path: "b.md", data: enc.encode("b") },
      { path: "SKILL.md", data: enc.encode("a") },
    ]);
    const b = await writeZip([
      { path: "SKILL.md", data: enc.encode("a") },
      { path: "b.md", data: enc.encode("b") },
    ]);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
  });

  it("round-trips content that does not benefit from compression", async () => {
    const random = crypto.getRandomValues(new Uint8Array(512));
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode("x") },
      { path: "blob.bin", data: random },
    ]);
    const files = unzipSync(bytes);
    expect(files["blob.bin"]).toEqual(random);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/zip-write.test.ts
```

预期：失败，`src/skills/zip` 不存在。

- [ ] **Step 3: 写实现**

`src/skills/zip.ts`：

```ts
export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
}

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 1980-01-01，zip 规范里最小的合法日期。固定它让同样的内容产出同样的字节。
const DOS_DATE = 0x21;
const DOS_TIME = 0;
// 0o100644 << 16：普通文件权限。CLI 会检查这个字段排除软链接，必须是普通文件位。
const EXTERNAL_ATTRS = 0x81a40000;

export async function writeZip(entries: ArchiveEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = enc.encode(entry.path);
    const crc = crc32(entry.data);
    const deflated = await deflateRaw(entry.data);
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // 文件名按 UTF-8 解释
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, EXTERNAL_ATTRS, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/zip-write.test.ts
```

预期：5 passed。

- [ ] **Step 5: 提交**

```bash
git add src/skills/zip.ts test/zip-write.test.ts
git commit -m "feat: crc32 and deterministic zip writer"
```

---

### Task 4: zip 与 tar.gz 读取器

**Files:**
- Modify: `src/skills/zip.ts`
- Create: `src/skills/tar.ts`, `scripts/make-fixtures.sh`, `test/fixtures/*`
- Test: `test/archive-read.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `src/skills/zip.ts`
- Produces:
  - `readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>>` — 键是压缩包内原始路径，不做清洗
  - `readTarGz(bytes: Uint8Array): Promise<Map<string, Uint8Array>>` — 同上
  - `class ArchiveError extends Error`（定义在 `src/skills/zip.ts`，`tar.ts` 复用导入）

两个函数都只负责"把容器拆开"，路径清洗和业务校验属于 Task 6。

- [ ] **Step 1: 写 fixture 生成脚本**

`scripts/make-fixtures.sh`：

```bash
#!/usr/bin/env bash
# 用系统 tar/zip 生成真实的测试数据，确保读取器面对的是真实世界的字节而非我们自己的输出。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=test/fixtures
rm -rf "$OUT" && mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/flat/references" "$TMP/flat/scripts"
cat > "$TMP/flat/SKILL.md" <<'MD'
---
name: demo-skill
description: A demo skill used by the test suite.
---

# Demo

Body text.
MD
echo '# API notes' > "$TMP/flat/references/api.md"
echo 'echo hi' > "$TMP/flat/scripts/run.sh"

# tar 打包 "." —— 条目会带 ./ 前缀，这正是需要被清洗掉的真实场景
( cd "$TMP/flat" && COPYFILE_DISABLE=1 tar czf - . ) > "$OUT/flat-dot.tar.gz"

# 外层包裹一层目录的 zip —— GitHub 下载的压缩包就是这个形状
mkdir -p "$TMP/wrap" && cp -R "$TMP/flat" "$TMP/wrap/demo-skill"
( cd "$TMP/wrap" && zip -q -r - demo-skill ) > "$OUT/wrapped.zip"

# 根目录直接是 SKILL.md 的 zip
( cd "$TMP/flat" && zip -q -r - . ) > "$OUT/flat.zip"

# 缺少 SKILL.md 的 zip
mkdir -p "$TMP/bad" && echo 'nope' > "$TMP/bad/README.md"
( cd "$TMP/bad" && zip -q -r - . ) > "$OUT/no-skill-md.zip"

# 含软链接的 tar.gz
mkdir -p "$TMP/link" && cp "$TMP/flat/SKILL.md" "$TMP/link/SKILL.md"
ln -s /etc/passwd "$TMP/link/evil"
( cd "$TMP/link" && COPYFILE_DISABLE=1 tar czf - . ) > "$OUT/symlink.tar.gz"

ls -l "$OUT"
```

```bash
chmod +x scripts/make-fixtures.sh
./scripts/make-fixtures.sh
```

- [ ] **Step 2: 写失败的测试**

fixture 用 `node:fs` 读取（`nodejs_compat` 已开启），不走打包器的二进制导入，省掉额外的 vitest 模块规则配置。

`test/archive-read.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArchiveError, readZip, writeZip } from "../src/skills/zip";
import { readTarGz } from "../src/skills/tar";

const dec = new TextDecoder();
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const flatZip = fixture("flat.zip");
const wrappedZip = fixture("wrapped.zip");
const flatDotTarGz = fixture("flat-dot.tar.gz");
const symlinkTarGz = fixture("symlink.tar.gz");

describe("readZip", () => {
  it("reads a zip produced by the system zip tool", async () => {
    const files = await readZip(flatZip);
    expect([...files.keys()]).toContain("SKILL.md");
    expect(dec.decode(files.get("SKILL.md"))).toContain("name: demo-skill");
    expect(dec.decode(files.get("references/api.md"))).toContain("API notes");
  });

  it("keeps the wrapper directory in the raw paths", async () => {
    const files = await readZip(wrappedZip);
    expect([...files.keys()]).toContain("demo-skill/SKILL.md");
    expect(files.has("SKILL.md")).toBe(false);
  });

  it("reads back what writeZip produced", async () => {
    const enc = new TextEncoder();
    const bytes = await writeZip([{ path: "SKILL.md", data: enc.encode("hello") }]);
    const files = await readZip(bytes);
    expect(dec.decode(files.get("SKILL.md"))).toBe("hello");
  });

  it("rejects bytes that are not a zip", async () => {
    await expect(readZip(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("readTarGz", () => {
  it("reads a tarball whose entries carry a ./ prefix", async () => {
    const files = await readTarGz(flatDotTarGz);
    expect([...files.keys()]).toContain("./SKILL.md");
    expect(dec.decode(files.get("./SKILL.md"))).toContain("name: demo-skill");
  });

  it("skips directory entries", async () => {
    const files = await readTarGz(flatDotTarGz);
    for (const key of files.keys()) expect(key.endsWith("/")).toBe(false);
  });

  it("rejects archives containing links", async () => {
    await expect(readTarGz(symlinkTarGz)).rejects.toBeInstanceOf(ArchiveError);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run test/archive-read.test.ts
```

预期：失败，`readZip` / `readTarGz` / `ArchiveError` 未导出。

- [ ] **Step 4: 实现 readZip**

在 `src/skills/zip.ts` 顶部加 `ArchiveError`，在文件末尾加 `readZip` 与 `inflateRaw`：

```ts
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEocd(view: DataView, length: number): number {
  const min = Math.max(0, length - 65535 - 22);
  for (let offset = length - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 22) throw new ArchiveError("不是合法的 zip：文件过短");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) throw new ArchiveError("不是合法的 zip：找不到中央目录结尾");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  const dec = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new ArchiveError("zip 中央目录损坏");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = dec.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset = offset + 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (flags & 1) throw new ArchiveError("不支持加密的 zip 条目");
    const fileType = (externalAttrs >>> 16) & 0xf000;
    if (fileType === 0xa000 || fileType === 0x1000) throw new ArchiveError("不支持压缩包中的链接条目");
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new ArchiveError("zip 局部头损坏");

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let content: Uint8Array;
    if (method === 0) content = raw;
    else if (method === 8) content = await inflateRaw(raw);
    else throw new ArchiveError(`不支持的 zip 压缩方法：${method}`);

    if (content.byteLength !== uncompressedSize) throw new ArchiveError(`zip 条目大小不符：${name}`);
    files.set(name, content);
  }

  return files;
}
```

- [ ] **Step 5: 实现 readTarGz**

`src/skills/tar.ts`：

```ts
import { ArchiveError } from "./zip";

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

export async function readTarGz(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new ArchiveError("不是合法的 gzip 数据");
  }
  let tar: Uint8Array;
  try {
    tar = await gunzip(bytes);
  } catch {
    throw new ArchiveError("gzip 解压失败");
  }

  const files = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const name = readString(header, 0, 100);
    const sizeText = readString(header, 124, 12).trim();
    const typeFlag = header[156];
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError("tar 条目大小非法");

    offset += 512;

    // '1' = 硬链接，'2' = 软链接
    if (typeFlag === 0x31 || typeFlag === 0x32) throw new ArchiveError("不支持压缩包中的链接条目");
    // '\0' 与 '0' = 普通文件；其余（目录 '5'、pax 头 'x'/'g' 等）跳过
    if (typeFlag === 0 || typeFlag === 0x30) {
      files.set(path, tar.slice(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run test/archive-read.test.ts
```

预期：7 passed。

- [ ] **Step 7: 提交**

```bash
git add src/skills/zip.ts src/skills/tar.ts scripts/make-fixtures.sh test/fixtures test/archive-read.test.ts
git commit -m "feat: zip and tar.gz readers backed by native decompression"
```

---

### Task 5: frontmatter 解析与校验

**Files:**
- Create: `src/skills/frontmatter.ts`
- Test: `test/frontmatter.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `parseFrontmatter(src: string): { data: Record<string, unknown>; body: string }`
  - `isValidSkillName(name: unknown): name is string`
  - `isValidDescription(value: unknown): value is string`

校验规则逐条对应 spec 3.2 节，即 CLI 源码里的 `isValidSkillName` / `isValidSkillEntryV2`。

- [ ] **Step 1: 写失败的测试**

`test/frontmatter.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { isValidDescription, isValidSkillName, parseFrontmatter } from "../src/skills/frontmatter";

describe("parseFrontmatter", () => {
  it("extracts simple key/value pairs", () => {
    const { data, body } = parseFrontmatter("---\nname: demo\ndescription: hi\n---\n# Title\n");
    expect(data.name).toBe("demo");
    expect(data.description).toBe("hi");
    expect(body).toBe("# Title\n");
  });

  it("handles folded block scalars", () => {
    const src = "---\nname: demo\ndescription: >-\n  first line\n  second line\n---\nbody";
    const { data } = parseFrontmatter(src);
    expect(data.description).toBe("first line second line");
  });

  it("returns empty data when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter("# Just markdown");
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown");
  });

  it("tolerates CRLF line endings", () => {
    const { data } = parseFrontmatter("---\r\nname: demo\r\ndescription: hi\r\n---\r\nbody");
    expect(data.name).toBe("demo");
  });
});

describe("isValidSkillName", () => {
  it.each(["a", "demo", "my-skill", "a1-b2", "x".repeat(64)])("accepts %s", (name) => {
    expect(isValidSkillName(name)).toBe(true);
  });

  it.each([
    ["", "空字符串"],
    ["x".repeat(65), "超过 64 字符"],
    ["Demo", "含大写"],
    ["my_skill", "含下划线"],
    ["my skill", "含空格"],
    ["-demo", "以连字符开头"],
    ["demo-", "以连字符结尾"],
    ["my--skill", "含连续连字符"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidSkillName(name)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidSkillName(undefined)).toBe(false);
    expect(isValidSkillName(42)).toBe(false);
  });
});

describe("isValidDescription", () => {
  it("accepts a normal description", () => {
    expect(isValidDescription("Does a thing.")).toBe(true);
  });

  it("rejects empty and oversized values", () => {
    expect(isValidDescription("")).toBe(false);
    expect(isValidDescription("x".repeat(1025))).toBe(false);
    expect(isValidDescription("x".repeat(1024))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/frontmatter.test.ts
```

预期：失败，模块不存在。

- [ ] **Step 3: 写实现**

`src/skills/frontmatter.ts`：

```ts
import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(src);
  if (!match) return { data: {}, body: src };
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    data = {};
  }
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  return { data: record, body: src.slice(match[0].length) };
}

export function isValidSkillName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > 64) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("-")) return false;
  if (name.includes("--")) return false;
  return true;
}

export function isValidDescription(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/frontmatter.test.ts
```

预期：全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/skills/frontmatter.ts test/frontmatter.test.ts
git commit -m "feat: frontmatter parsing and CLI-compatible validation"
```

---

### Task 6: normalizeUpload 流水线

**Files:**
- Create: `src/skills/normalize.ts`
- Test: `test/normalize.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `readZip` / `readTarGz` / `ArchiveError`、Task 3 的 `writeZip`、Task 5 的三个函数
- Produces:
  - `class UploadError extends Error { readonly status = 400 }`
  - `interface NormalizedSkill { name: string; description: string; skillMd: string; files: Array<{ path: string; size: number }>; zip: Uint8Array; digest: string }`
  - `normalizeUpload(bytes: Uint8Array): Promise<NormalizedSkill>`
  - 常量 `MAX_UPLOAD_BYTES = 2 * 1024 * 1024`、`MAX_UNPACKED_BYTES = 8 * 1024 * 1024`、`MAX_FILES = 200`

格式靠魔数判断，不依赖 Content-Type 或文件名，所以签名里不需要传这两者。

- [ ] **Step 1: 写失败的测试**

`test/normalize.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_FILES, normalizeUpload, UploadError } from "../src/skills/normalize";
import { readZip, writeZip } from "../src/skills/zip";

const enc = new TextEncoder();
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";

describe("normalizeUpload", () => {
  it("accepts a bare SKILL.md", async () => {
    const result = await normalizeUpload(enc.encode(GOOD_MD));
    expect(result.name).toBe("demo-skill");
    expect(result.description).toBe("A demo skill used by the test suite.");
    expect(result.files).toEqual([{ path: "SKILL.md", size: enc.encode(GOOD_MD).length }]);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("strips ./ prefixes from tar entries", async () => {
    const result = await normalizeUpload(fixture("flat-dot.tar.gz"));
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md", "references/api.md", "scripts/run.sh",
    ]);
  });

  it("strips a single wrapping directory", async () => {
    const result = await normalizeUpload(fixture("wrapped.zip"));
    expect(result.files.map((f) => f.path)).toContain("SKILL.md");
    expect(result.files.every((f) => !f.path.startsWith("demo-skill/"))).toBe(true);
  });

  it("accepts a zip that already has SKILL.md at the root", async () => {
    const result = await normalizeUpload(fixture("flat.zip"));
    expect(result.name).toBe("demo-skill");
  });

  it("rejects an archive without SKILL.md", async () => {
    await expect(normalizeUpload(fixture("no-skill-md.zip"))).rejects.toBeInstanceOf(UploadError);
  });

  it("rejects archives containing links", async () => {
    await expect(normalizeUpload(fixture("symlink.tar.gz"))).rejects.toBeInstanceOf(UploadError);
  });

  it("rejects path traversal", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode(GOOD_MD) },
      { path: "../../etc/passwd", data: enc.encode("x") },
    ]);
    await expect(normalizeUpload(bytes)).rejects.toThrow(/路径/);
  });

  it("drops macOS junk entries", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode(GOOD_MD) },
      { path: "__MACOSX/._SKILL.md", data: enc.encode("junk") },
      { path: ".DS_Store", data: enc.encode("junk") },
    ]);
    const result = await normalizeUpload(bytes);
    expect(result.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("rejects an invalid name in frontmatter", async () => {
    const md = "---\nname: Demo_Skill\ndescription: nope\n---\nbody";
    await expect(normalizeUpload(enc.encode(md))).rejects.toThrow(/name/);
  });

  it("rejects a missing description", async () => {
    const md = "---\nname: demo\n---\nbody";
    await expect(normalizeUpload(enc.encode(md))).rejects.toThrow(/description/);
  });

  it("rejects an oversized description", async () => {
    const md = `---\nname: demo\ndescription: ${"x".repeat(1025)}\n---\nbody`;
    await expect(normalizeUpload(enc.encode(md))).rejects.toThrow(/description/);
  });

  it("rejects too many files", async () => {
    const entries = [{ path: "SKILL.md", data: enc.encode(GOOD_MD) }];
    for (let i = 0; i <= MAX_FILES; i++) entries.push({ path: `f${i}.txt`, data: enc.encode("x") });
    const bytes = await writeZip(entries);
    await expect(normalizeUpload(bytes)).rejects.toThrow(/文件数/);
  });

  it("rejects an upload over the size limit", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    await expect(normalizeUpload(big)).rejects.toThrow(/上传/);
  });

  it("produces a zip whose root holds SKILL.md and whose digest matches its bytes", async () => {
    const result = await normalizeUpload(fixture("wrapped.zip"));
    const files = await readZip(result.zip);
    expect(files.has("SKILL.md")).toBe(true);
    const hash = await crypto.subtle.digest("SHA-256", result.zip);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(result.digest).toBe(`sha256:${hex}`);
  });

  it("is deterministic for identical input", async () => {
    const a = await normalizeUpload(fixture("flat.zip"));
    const b = await normalizeUpload(fixture("flat.zip"));
    expect(a.digest).toBe(b.digest);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/normalize.test.ts
```

预期：失败，`src/skills/normalize` 不存在。

- [ ] **Step 3: 写实现**

`src/skills/normalize.ts`：

```ts
import { isValidDescription, isValidSkillName, parseFrontmatter } from "./frontmatter";
import { readTarGz } from "./tar";
import { ArchiveError, readZip, writeZip, type ArchiveEntry } from "./zip";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 200;

export class UploadError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface NormalizedSkill {
  name: string;
  description: string;
  skillMd: string;
  files: Array<{ path: string; size: number }>;
  zip: Uint8Array;
  digest: string;
}

function isGzip(b: Uint8Array): boolean {
  return b.length > 1 && b[0] === 0x1f && b[1] === 0x8b;
}

function isZip(b: Uint8Array): boolean {
  return b.length > 1 && b[0] === 0x50 && b[1] === 0x4b;
}

function isJunk(path: string): boolean {
  if (path.startsWith("__MACOSX/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === ".DS_Store" || base === "Thumbs.db" || base.startsWith("._");
}

function cleanPath(raw: string): string {
  if (!raw || raw.includes("\0")) throw new UploadError(`压缩包内路径非法：${raw}`);
  if (raw.startsWith("/") || raw.startsWith("\\")) throw new UploadError(`压缩包内路径非法（绝对路径）：${raw}`);
  if (/^[A-Za-z]:/.test(raw)) throw new UploadError(`压缩包内路径非法（盘符）：${raw}`);
  if (raw.includes("\\")) throw new UploadError(`压缩包内路径非法（反斜杠）：${raw}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new UploadError(`压缩包内路径非法：${raw}`);
  if (parts.includes("..")) throw new UploadError(`压缩包内路径非法（越界）：${raw}`);
  return parts.join("/");
}

function stripWrapperDir(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has("SKILL.md")) return files;
  const paths = [...files.keys()];
  if (paths.length === 0) return files;
  const first = paths[0].split("/")[0];
  const shared = paths.every((p) => p.startsWith(`${first}/`));
  if (!shared) return files;
  const out = new Map<string, Uint8Array>();
  for (const [path, data] of files) out.set(path.slice(first.length + 1), data);
  return out;
}

async function extract(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  try {
    if (isGzip(bytes)) return await readTarGz(bytes);
    if (isZip(bytes)) return await readZip(bytes);
  } catch (err) {
    if (err instanceof ArchiveError) throw new UploadError(err.message);
    throw err;
  }
  // 既不是 gzip 也不是 zip，按单个 SKILL.md 文本处理。
  // 解码再编码一次是为了把非法 UTF-8 字节规范成替换字符，保证 digest 稳定。
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return new Map([["SKILL.md", new TextEncoder().encode(text)]]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function normalizeUpload(bytes: Uint8Array): Promise<NormalizedSkill> {
  if (bytes.length === 0) throw new UploadError("上传内容为空");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(`上传体积超出上限：${bytes.length} 字节 > ${MAX_UPLOAD_BYTES} 字节`);
  }

  const raw = await extract(bytes);

  const cleaned = new Map<string, Uint8Array>();
  for (const [path, data] of raw) {
    if (isJunk(path)) continue;
    cleaned.set(cleanPath(path), data);
  }

  const files = stripWrapperDir(cleaned);
  const filtered = new Map<string, Uint8Array>();
  for (const [path, data] of files) {
    if (isJunk(path)) continue;
    filtered.set(path, data);
  }

  if (filtered.size === 0) throw new UploadError("压缩包内没有可用文件");
  if (filtered.size > MAX_FILES) {
    throw new UploadError(`文件数超出上限：${filtered.size} > ${MAX_FILES}`);
  }

  let unpacked = 0;
  for (const data of filtered.values()) unpacked += data.byteLength;
  if (unpacked > MAX_UNPACKED_BYTES) {
    throw new UploadError(`解包后体积超出上限：${unpacked} 字节 > ${MAX_UNPACKED_BYTES} 字节`);
  }

  const skillMdBytes = filtered.get("SKILL.md");
  if (!skillMdBytes) throw new UploadError("压缩包根目录缺少 SKILL.md");
  const skillMd = new TextDecoder().decode(skillMdBytes);

  const { data } = parseFrontmatter(skillMd);
  if (!isValidSkillName(data.name)) {
    throw new UploadError(
      "SKILL.md 的 frontmatter 中 name 不合法：必须匹配 ^[a-z0-9-]+$，长度 1-64，不以连字符开头或结尾，不含连续连字符",
    );
  }
  if (!isValidDescription(data.description)) {
    throw new UploadError("SKILL.md 的 frontmatter 中 description 不合法：必须非空且不超过 1024 字符");
  }

  const entries: ArchiveEntry[] = [...filtered].map(([path, bytes]) => ({ path, data: bytes }));
  const zip = await writeZip(entries);

  return {
    name: data.name,
    description: data.description,
    skillMd,
    files: [...filtered]
      .map(([path, bytes]) => ({ path, size: bytes.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    zip,
    digest: `sha256:${await sha256Hex(zip)}`,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/normalize.test.ts
```

预期：全部通过。若"rejects path traversal"未通过，检查 `cleanPath` 是否在 `filter` 之后才判断 `..`。

- [ ] **Step 5: 提交**

```bash
git add src/skills/normalize.ts test/normalize.test.ts
git commit -m "feat: upload normalization pipeline"
```

---

### Task 7: markdown 渲染与净化

**Files:**
- Create: `src/render/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `renderMarkdown(md: string): Promise<string>` — 返回已净化的 HTML 片段

- [ ] **Step 1: 写失败的测试**

`test/markdown.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render/markdown";

describe("renderMarkdown", () => {
  it("renders headings and code blocks", async () => {
    const html = await renderMarkdown("# Title\n\n```js\nconst a = 1;\n```\n");
    expect(html).toContain("<h1");
    expect(html).toContain("const a = 1;");
  });

  it("strips script tags and their content", async () => {
    const html = await renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("strips inline event handlers", async () => {
    const html = await renderMarkdown('<div onclick="steal()">hi</div>');
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });

  it("strips javascript: links", async () => {
    const html = await renderMarkdown('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("strips iframes", async () => {
    const html = await renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("keeps ordinary links intact", async () => {
    const html = await renderMarkdown("[docs](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("escapes code-fence content rather than executing it", async () => {
    const html = await renderMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/markdown.test.ts
```

预期：失败，模块不存在。

- [ ] **Step 3: 写实现**

`src/render/markdown.ts`：

```ts
import { marked } from "marked";

const BLOCKED_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input",
  "button", "link", "meta", "base", "svg", "math",
]);

const DANGEROUS_URL = /^\s*(javascript|data|vbscript):/i;

export async function renderMarkdown(md: string): Promise<string> {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;

  const rewritten = new HTMLRewriter()
    .on("*", {
      element(el) {
        if (BLOCKED_TAGS.has(el.tagName)) {
          el.remove();
          return;
        }
        for (const [name, value] of el.attributes) {
          if (name.toLowerCase().startsWith("on")) {
            el.removeAttribute(name);
            continue;
          }
          if ((name === "href" || name === "src") && DANGEROUS_URL.test(value)) {
            el.removeAttribute(name);
          }
        }
      },
    })
    .transform(new Response(html));

  return await rewritten.text();
}
```

`el.remove()` 会连同子节点一并移除，所以 `<script>` 里的内容不会遗留在输出中。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/markdown.test.ts
```

预期：7 passed。

- [ ] **Step 5: 提交**

```bash
git add src/render/markdown.ts test/markdown.test.ts
git commit -m "feat: markdown rendering sanitized with HTMLRewriter"
```

---

### Task 8: 鉴权模块

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `UserRow` / `SkillRow`、Task 1 的 `Env`
- Produces:
  - `PBKDF2_ITERATIONS = 10_000`、`MIN_PASSWORD_LENGTH = 12`、`SESSION_COOKIE = "sg_session"`、`SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000`
  - `hashPassword(password: string, iterations?: number): Promise<string>`
  - `verifyPassword(password: string, stored: string): Promise<boolean>`
  - `randomHex(byteLength: number): string`
  - `sha256Hex(input: string): Promise<string>`
  - `startSession(c: Ctx, userId: string): Promise<void>`
  - `clearSession(c: Ctx): void`
  - `currentUser(c: Ctx): Promise<UserRow | null>`
  - `userFromApiToken(c: Ctx): Promise<UserRow | null>`
  - `canManage(user: UserRow, skill: SkillRow): boolean`
  - `type Ctx = Context<{ Bindings: Env }>`

- [ ] **Step 1: 写失败的测试**

`test/auth.test.ts`：

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  canManage, hashPassword, PBKDF2_ITERATIONS, randomHex, sha256Hex, verifyPassword,
} from "../src/auth";
import type { SkillRow, UserRow } from "../src/db/queries";

const user = (over: Partial<UserRow> = {}): UserRow => ({
  id: "u1", username: "alice", password_hash: "h", role: "member",
  install_key: "k", api_token_hash: null, created_at: 0, last_login_at: null, ...over,
});

const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  slug: "demo", description: "d", visibility: "private", owner_id: "u1",
  latest_version: 1, created_at: 0, updated_at: 0, ...over,
});

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong password xx", stored)).toBe(false);
  });

  it("encodes scheme, iterations, salt and hash", async () => {
    const stored = await hashPassword("correct horse battery");
    const parts = stored.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(Number(parts[1])).toBe(PBKDF2_ITERATIONS);
    expect(parts).toHaveLength(4);
  });

  it("uses a fresh salt each time", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
  });

  it("verifies hashes stored with a different iteration count", async () => {
    const stored = await hashPassword("correct horse battery", 1000);
    expect(stored).toContain("$1000$");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("randomHex", () => {
  it("returns the requested number of bytes as hex", () => {
    expect(randomHex(16)).toMatch(/^[a-f0-9]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of an empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("canManage", () => {
  it("lets an owner manage their own skill", () => {
    expect(canManage(user({ id: "u1" }), skill({ owner_id: "u1" }))).toBe(true);
  });

  it("stops a member managing someone else's skill", () => {
    expect(canManage(user({ id: "u2" }), skill({ owner_id: "u1" }))).toBe(false);
  });

  it("lets an admin manage anything", () => {
    expect(canManage(user({ id: "u2", role: "admin" }), skill({ owner_id: "u1" }))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/auth.test.ts
```

预期：失败，`src/auth` 不存在。

- [ ] **Step 3: 写实现**

`src/auth.ts`：

```ts
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { getUserById } from "./db/queries";
import type { SkillRow, UserRow } from "./db/queries";
import type { Env } from "./types";

export type Ctx = Context<{ Bindings: Env }>;

export const PBKDF2_ITERATIONS = 10_000;
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_COOKIE = "sg_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  let salt: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
  } catch {
    return false;
  }
  const bits = await deriveBits(password, salt, iterations);
  return constantTimeEqual(toBase64(bits), parts[3]);
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function startSession(c: Ctx, userId: string): Promise<void> {
  const payload = JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS });
  await setSignedCookie(c, SESSION_COOKIE, payload, c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSession(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function currentUser(c: Ctx): Promise<UserRow | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!raw) return null;
  let payload: { uid?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload.uid !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return await getUserById(c.env.DB, payload.uid);
}

export async function userFromApiToken(c: Ctx): Promise<UserRow | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const hash = await sha256Hex(token);
  return await c.env.DB.prepare("SELECT * FROM users WHERE api_token_hash = ?")
    .bind(hash)
    .first<UserRow>();
}

export function canManage(user: UserRow, skill: SkillRow): boolean {
  return user.role === "admin" || user.id === skill.owner_id;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/auth.test.ts
```

预期：全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: password hashing, sessions and permission checks"
```

---

### Task 9: 用户相关路由与页面骨架

**Files:**
- Create: `src/views/layout.tsx`, `src/views/auth.tsx`, `src/routes/users.tsx`, `test/helpers.ts`
- Modify: `src/index.ts`
- Test: `test/users.test.ts`

**Interfaces:**
- Consumes: Task 8 全部导出、Task 2 的查询函数
- Produces:
  - `Layout(props: { title: string; user: UserRow | null; children: unknown }): JSX.Element`（`src/views/layout.tsx`）
  - `usersRoutes: Hono<{ Bindings: Env }>`（`src/routes/users.tsx`），挂载在根路径
  - `test/helpers.ts` 导出 `resetDb(): Promise<void>`、`seedUser(opts): Promise<{ user: UserRow; password: string }>`、`login(username, password): Promise<string>` 返回 Cookie 头

- [ ] **Step 1: 写失败的测试**

`test/helpers.ts`：

```ts
import { SELF, env } from "cloudflare:test";
import { hashPassword, randomHex } from "../src/auth";
import { createUser, getUserByUsername } from "../src/db/queries";
import type { UserRow } from "../src/db/queries";

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM versions"),
    env.DB.prepare("DELETE FROM skills"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

export async function seedUser(
  opts: { username?: string; role?: "admin" | "member"; password?: string } = {},
): Promise<{ user: UserRow; password: string }> {
  const username = opts.username ?? "alice";
  const password = opts.password ?? "a-very-long-password";
  await createUser(env.DB, {
    id: randomHex(8),
    username,
    passwordHash: await hashPassword(password),
    role: opts.role ?? "admin",
    installKey: randomHex(16),
  });
  const user = await getUserByUsername(env.DB, username);
  if (!user) throw new Error("seedUser failed");
  return { user, password };
}

export async function login(username: string, password: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("Set-Cookie");
  if (!cookie) throw new Error(`login failed: ${res.status}`);
  return cookie.split(";")[0];
}
```

`test/users.test.ts`：

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { countUsers, getUserByUsername } from "../src/db/queries";
import { login, resetDb, seedUser } from "./helpers";

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
  redirect: "manual" as const,
});

describe("/setup", () => {
  beforeEach(resetDb);

  it("is reachable while no user exists", async () => {
    const res = await SELF.fetch("http://localhost/setup");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("创建管理员");
  });

  it("creates the first admin and signs them in", async () => {
    const res = await SELF.fetch(
      "http://localhost/setup",
      form({ username: "root", password: "a-very-long-password" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
    const user = await getUserByUsername(env.DB, "root");
    expect(user?.role).toBe("admin");
    expect(user?.install_key).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const res = await SELF.fetch("http://localhost/setup", form({ username: "root", password: "short" }));
    expect(res.status).toBe(400);
    expect(await countUsers(env.DB)).toBe(0);
  });

  it("returns 404 once a user exists", async () => {
    await seedUser();
    expect((await SELF.fetch("http://localhost/setup")).status).toBe(404);
  });
});

describe("/login", () => {
  beforeEach(resetDb);

  it("sets a session cookie on success", async () => {
    const { password } = await seedUser({ username: "alice" });
    const res = await SELF.fetch("http://localhost/login", form({ username: "alice", password }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
  });

  it("gives the same generic error for a bad password and a missing user", async () => {
    await seedUser({ username: "alice" });
    const bad = await SELF.fetch("http://localhost/login", form({ username: "alice", password: "wrong-password-x" }));
    const missing = await SELF.fetch("http://localhost/login", form({ username: "nobody", password: "wrong-password-x" }));
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await bad.text()).toContain("用户名或密码不正确");
    expect(await missing.text()).toContain("用户名或密码不正确");
  });
});

describe("/me", () => {
  beforeEach(resetDb);

  it("redirects anonymous visitors to /login", async () => {
    const res = await SELF.fetch("http://localhost/me", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("shows a ready-to-copy install command", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me", { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  it("rotates the install key", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me/install-key", {
      ...form({}), headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(res.status).toBe(302);
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.install_key).not.toBe(user.install_key);
  });

  it("issues an api token once and stores only its hash", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me/api-token", {
      ...form({}), headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    const html = await res.text();
    const match = /sgt_[a-f0-9]{32}/.exec(html);
    expect(match).not.toBeNull();
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.api_token_hash).not.toBeNull();
    expect(after?.api_token_hash).not.toContain(match![0]);
  });

  it("changes the password when the current one is supplied", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me/password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ current: password, next: "another-long-password" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    await login("alice", "another-long-password");
  });
});

describe("/admin/users", () => {
  beforeEach(resetDb);

  it("is forbidden for members", async () => {
    const { password } = await seedUser({ username: "bob", role: "member" });
    const cookie = await login("bob", password);
    const res = await SELF.fetch("http://localhost/admin/users", { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it("lets an admin create a member", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const res = await SELF.fetch("http://localhost/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ username: "carol", password: "carols-long-password", role: "member" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const carol = await getUserByUsername(env.DB, "carol");
    expect(carol?.role).toBe("member");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/users.test.ts
```

预期：失败，路由不存在。

- [ ] **Step 3: 写页面骨架**

`src/views/layout.tsx`：

```tsx
import type { UserRow } from "../db/queries";

export function Layout(props: { title: string; user: UserRow | null; children?: unknown }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · skillsgist</title>
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body class="min-h-screen bg-slate-50 text-slate-900">
        <header class="border-b border-slate-200 bg-white">
          <nav class="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3">
            <a href="/" class="font-semibold">skillsgist</a>
            <span class="flex-1" />
            {props.user ? (
              <>
                <a href="/new" class="text-sm text-slate-600 hover:text-slate-900">发布</a>
                {props.user.role === "admin" ? (
                  <a href="/admin/users" class="text-sm text-slate-600 hover:text-slate-900">用户</a>
                ) : null}
                <a href="/me" class="text-sm text-slate-600 hover:text-slate-900">{props.user.username}</a>
                <form method="post" action="/logout">
                  <button type="submit" class="text-sm text-slate-600 hover:text-slate-900">退出</button>
                </form>
              </>
            ) : (
              <a href="/login" class="text-sm text-slate-600 hover:text-slate-900">登录</a>
            )}
          </nav>
        </header>
        <main class="mx-auto max-w-4xl px-4 py-8">{props.children}</main>
      </body>
    </html>
  );
}

export function Field(props: { label: string; name: string; type?: string; value?: string; hint?: string }) {
  return (
    <label class="block">
      <span class="block text-sm font-medium text-slate-700">{props.label}</span>
      <input
        class="mt-1 w-full rounded border border-slate-300 px-3 py-2"
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        required
      />
      {props.hint ? <span class="mt-1 block text-xs text-slate-500">{props.hint}</span> : null}
    </label>
  );
}

export function Button(props: { children?: unknown }) {
  return (
    <button type="submit" class="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white">
      {props.children}
    </button>
  );
}

export function Alert(props: { children?: unknown }) {
  return <p class="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{props.children}</p>;
}
```

`src/views/auth.tsx`：

```tsx
import { Alert, Button, Field, Layout } from "./layout";
import type { UserRow } from "../db/queries";

export function SetupPage(props: { error?: string }) {
  return (
    <Layout title="初始化" user={null}>
      <h1 class="mb-4 text-xl font-semibold">创建管理员</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <form method="post" action="/setup" class="max-w-sm space-y-4">
        <Field label="用户名" name="username" hint="小写字母、数字与连字符，2-32 位" />
        <Field label="密码" name="password" type="password" hint="至少 12 个字符" />
        <Button>创建</Button>
      </form>
    </Layout>
  );
}

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="登录" user={null}>
      <h1 class="mb-4 text-xl font-semibold">登录</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <form method="post" action="/login" class="max-w-sm space-y-4">
        <Field label="用户名" name="username" />
        <Field label="密码" name="password" type="password" />
        <Button>登录</Button>
      </form>
    </Layout>
  );
}

export function MePage(props: { user: UserRow; origin: string; newToken?: string; error?: string }) {
  const installUrl = `${props.origin}/i/${props.user.install_key}`;
  return (
    <Layout title="我的账号" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">我的账号</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}

      <section class="mb-8">
        <h2 class="mb-2 font-medium">安装全部 skill</h2>
        <pre class="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-slate-100">npx skills add {installUrl}</pre>
        <p class="mt-2 text-xs text-slate-500">
          这串 key 只有安装权限，不能登录、发布或删除。怀疑泄漏时点下面的按钮重置。
        </p>
        <form method="post" action="/me/install-key" class="mt-2">
          <Button>重置 install key</Button>
        </form>
      </section>

      <section class="mb-8">
        <h2 class="mb-2 font-medium">API token（用于 curl 发布）</h2>
        {props.newToken ? (
          <pre class="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-slate-100">{props.newToken}</pre>
        ) : null}
        {props.newToken ? (
          <p class="mt-2 text-xs text-amber-700">这串 token 只显示这一次，请立刻保存。</p>
        ) : (
          <p class="mt-2 text-xs text-slate-500">
            当前状态：{props.user.api_token_hash ? "已启用" : "未生成"}
          </p>
        )}
        <div class="mt-2 flex gap-2">
          <form method="post" action="/me/api-token"><Button>生成新 token</Button></form>
          {props.user.api_token_hash ? (
            <form method="post" action="/me/api-token/revoke"><Button>吊销</Button></form>
          ) : null}
        </div>
      </section>

      <section>
        <h2 class="mb-2 font-medium">修改密码</h2>
        <form method="post" action="/me/password" class="max-w-sm space-y-4">
          <Field label="当前密码" name="current" type="password" />
          <Field label="新密码" name="next" type="password" hint="至少 12 个字符" />
          <Button>保存</Button>
        </form>
      </section>
    </Layout>
  );
}

export function UsersPage(props: { user: UserRow; users: UserRow[]; error?: string }) {
  return (
    <Layout title="用户管理" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">用户管理</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <table class="mb-8 w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-slate-500">
            <th class="py-2">用户名</th><th>角色</th><th>最近登录</th>
          </tr>
        </thead>
        <tbody>
          {props.users.map((u) => (
            <tr class="border-b border-slate-100">
              <td class="py-2">{u.username}</td>
              <td>{u.role}</td>
              <td>{u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 10) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 class="mb-2 font-medium">新增用户</h2>
      <form method="post" action="/admin/users" class="max-w-sm space-y-4">
        <Field label="用户名" name="username" />
        <Field label="初始密码" name="password" type="password" hint="至少 12 个字符" />
        <label class="block">
          <span class="block text-sm font-medium text-slate-700">角色</span>
          <select name="role" class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <Button>创建</Button>
      </form>
    </Layout>
  );
}
```

- [ ] **Step 4: 写路由**

`src/routes/users.tsx`：

```tsx
import { Hono } from "hono";
import {
  clearSession, currentUser, hashPassword, MIN_PASSWORD_LENGTH, randomHex,
  sha256Hex, startSession, verifyPassword,
} from "../auth";
import {
  countUsers, createUser, getUserById, getUserByUsername, listUsers,
  touchLogin, updateApiTokenHash, updateInstallKey, updatePassword,
} from "../db/queries";
import type { Env } from "../types";
import { LoginPage, MePage, SetupPage, UsersPage } from "../views/auth";

const USERNAME = /^[a-z0-9-]{2,32}$/;

export const usersRoutes = new Hono<{ Bindings: Env }>();

usersRoutes.get("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return c.html(<SetupPage />);
});

usersRoutes.post("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  if (!USERNAME.test(username)) {
    return c.html(<SetupPage error="用户名必须是 2-32 位的小写字母、数字或连字符" />, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.html(<SetupPage error={`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`} />, 400);
  }
  const id = randomHex(8);
  await createUser(c.env.DB, {
    id, username, passwordHash: await hashPassword(password), role: "admin", installKey: randomHex(16),
  });
  await startSession(c, id);
  return c.redirect("/", 302);
});

usersRoutes.get("/login", async (c) => c.html(<LoginPage />));

usersRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const user = await getUserByUsername(c.env.DB, username);
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) return c.html(<LoginPage error="用户名或密码不正确" />, 401);
  await touchLogin(c.env.DB, user.id, Date.now());
  await startSession(c, user.id);
  return c.redirect("/", 302);
});

usersRoutes.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/", 302);
});

usersRoutes.get("/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  return c.html(<MePage user={user} origin={new URL(c.req.url).origin} />);
});

usersRoutes.post("/me/install-key", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  await updateInstallKey(c.env.DB, user.id, randomHex(16));
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/api-token", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const token = `sgt_${randomHex(16)}`;
  await updateApiTokenHash(c.env.DB, user.id, await sha256Hex(token));
  const fresh = await getUserById(c.env.DB, user.id);
  return c.html(<MePage user={fresh ?? user} origin={new URL(c.req.url).origin} newToken={token} />);
});

usersRoutes.post("/me/api-token/revoke", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  await updateApiTokenHash(c.env.DB, user.id, null);
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/password", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const body = await c.req.parseBody();
  const origin = new URL(c.req.url).origin;
  if (!(await verifyPassword(String(body.current ?? ""), user.password_hash))) {
    return c.html(<MePage user={user} origin={origin} error="当前密码不正确" />, 400);
  }
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return c.html(<MePage user={user} origin={origin} error={`新密码至少 ${MIN_PASSWORD_LENGTH} 个字符`} />, 400);
  }
  await updatePassword(c.env.DB, user.id, await hashPassword(next));
  return c.redirect("/me", 302);
});

usersRoutes.get("/admin/users", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("仅管理员可访问", 403);
  return c.html(<UsersPage user={user} users={await listUsers(c.env.DB)} />);
});

usersRoutes.post("/admin/users", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("仅管理员可访问", 403);
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const role = body.role === "admin" ? "admin" : "member";
  const fail = async (error: string) =>
    c.html(<UsersPage user={user} users={await listUsers(c.env.DB)} error={error} />, 400);
  if (!USERNAME.test(username)) return fail("用户名必须是 2-32 位的小写字母、数字或连字符");
  if (password.length < MIN_PASSWORD_LENGTH) return fail(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  if (await getUserByUsername(c.env.DB, username)) return fail("用户名已存在");
  await createUser(c.env.DB, {
    id: randomHex(8), username, passwordHash: await hashPassword(password), role, installKey: randomHex(16),
  });
  return c.redirect("/admin/users", 302);
});
```

- [ ] **Step 5: 挂载路由**

`src/index.ts` 改为：

```tsx
import { Hono } from "hono";
import { usersRoutes } from "./routes/users";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.route("/", usersRoutes);

export default app;
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run test/users.test.ts
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/views src/routes/users.tsx src/index.ts test/helpers.ts test/users.test.ts
git commit -m "feat: setup, login, account and user management routes"
```

---

### Task 10: 发布路径

**Files:**
- Create: `src/publish.ts`, `src/routes/publish.tsx`, `src/views/publish.tsx`
- Modify: `src/index.ts`
- Test: `test/publish.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `normalizeUpload` / `UploadError`、Task 7 的 `renderMarkdown`、Task 8 的 `currentUser` / `userFromApiToken` / `canManage`、Task 2 的 `insertVersion` / `getSkill` / `getVersion`
- Produces:
  - `interface PublishOutcome { slug: string; version: number; digest: string; unchanged: boolean; files: Array<{ path: string; size: number }> }`
  - `publishBytes(env: Env, user: UserRow, bytes: Uint8Array, opts: { expectedSlug?: string; visibility?: "public" | "private" }): Promise<PublishOutcome>`（`src/publish.ts`）
  - `class ForbiddenError extends Error { readonly status = 403 }`（`src/publish.ts`）
  - `publishRoutes: Hono<{ Bindings: Env }>`（`src/routes/publish.tsx`）

- [ ] **Step 1: 写失败的测试**

`test/publish.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill, getVersion, listVersions } from "../src/db/queries";
import { login, resetDb, seedUser } from "./helpers";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";

async function apiToken(cookie: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/me/api-token", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
  });
  const match = /sgt_[a-f0-9]{32}/.exec(await res.text());
  if (!match) throw new Error("no token issued");
  return match[0];
}

describe("PUT /api/skills/:slug", () => {
  beforeEach(resetDb);

  it("publishes a zip and stores the artifact in R2", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
      body: fixture("wrapped.zip"),
    });
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
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    const version = await getVersion(env.DB, "demo-skill", 1);
    expect(version?.html).toContain("<h1");
  });

  it("does not create a new version when content is unchanged", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const put = () =>
      SELF.fetch("http://localhost/api/skills/demo-skill", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
        body: GOOD_MD,
      });
    expect((await put()).status).toBe(201);
    const second = await put();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ unchanged: true, version: 1 });
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(1);
  });

  it("creates version 2 when content changes", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const put = (md: string) =>
      SELF.fetch("http://localhost/api/skills/demo-skill", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
        body: md,
      });
    await put(GOOD_MD);
    const res = await put(`${GOOD_MD}\nmore text\n`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2 });
  });

  it("rejects a slug that disagrees with the frontmatter name", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const res = await SELF.fetch("http://localhost/api/skills/other-name", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: expect.stringContaining("demo-skill"),
    });
  });

  it("rejects requests without a valid api token", async () => {
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: "Bearer sgt_deadbeef", "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(404);
  });

  it("stops a member overwriting another user's skill", async () => {
    const alice = await seedUser({ username: "alice" });
    const aliceToken = await apiToken(await login("alice", alice.password));
    await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    const bob = await seedUser({ username: "bob", role: "member" });
    const bobToken = await apiToken(await login("bob", bob.password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "text/markdown" },
      body: `${GOOD_MD}\nbob was here\n`,
    });
    expect(res.status).toBe(403);
  });

  it("surfaces normalization errors as 400 with a reason", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
      body: fixture("no-skill-md.zip"),
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: expect.stringContaining("SKILL.md"),
    });
  });
});

describe("POST /new", () => {
  beforeEach(resetDb);

  it("publishes an uploaded file", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("file", new File([fixture("flat.zip")], "flat.zip", { type: "application/zip" }));
    form.set("visibility", "public");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/s/demo-skill");
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  it("publishes pasted markdown", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", GOOD_MD);
    form.set("visibility", "private");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("re-renders the form with the reason on failure", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", "---\nname: Bad_Name\ndescription: x\n---\nbody");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("name");
  });

  it("requires a login", async () => {
    const res = await SELF.fetch("http://localhost/new", { redirect: "manual" });
    expect(res.status).toBe(302);
  });
});

describe("POST /s/:slug/edit", () => {
  beforeEach(resetDb);

  it("saves edited markdown as a new version", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", GOOD_MD);
    await SELF.fetch("http://localhost/new", { method: "POST", headers: { Cookie: cookie }, body: form });

    const edit = new FormData();
    edit.set("markdown", `${GOOD_MD}\nedited\n`);
    const res = await SELF.fetch("http://localhost/s/demo-skill/edit", {
      method: "POST", headers: { Cookie: cookie }, body: edit, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/publish.test.ts
```

预期：失败，路由不存在。

- [ ] **Step 3: 写发布核心**

`src/publish.ts`：

```ts
import { getSkill, getVersion, insertVersion } from "./db/queries";
import type { UserRow } from "./db/queries";
import { renderMarkdown } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import type { Env } from "./types";

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface PublishOutcome {
  slug: string;
  version: number;
  digest: string;
  unchanged: boolean;
  files: Array<{ path: string; size: number }>;
}

export async function publishBytes(
  env: Env,
  user: UserRow,
  bytes: Uint8Array,
  opts: { expectedSlug?: string; visibility?: "public" | "private" } = {},
): Promise<PublishOutcome> {
  const normalized = await normalizeUpload(bytes);

  if (opts.expectedSlug && opts.expectedSlug !== normalized.name) {
    throw new UploadError(
      `URL 里的 slug 是 ${opts.expectedSlug}，但 SKILL.md 的 name 是 ${normalized.name}，两者必须一致`,
    );
  }

  const existing = await getSkill(env.DB, normalized.name);
  if (existing && user.role !== "admin" && existing.owner_id !== user.id) {
    throw new ForbiddenError(`skill ${normalized.name} 属于其他用户，无权覆盖`);
  }

  if (existing) {
    const latest = await getVersion(env.DB, existing.slug, existing.latest_version);
    if (latest?.digest === normalized.digest) {
      return {
        slug: existing.slug,
        version: existing.latest_version,
        digest: normalized.digest,
        unchanged: true,
        files: normalized.files,
      };
    }
  }

  const html = await renderMarkdown(normalized.skillMd);
  const version = await insertVersion(env.DB, {
    slug: normalized.name,
    digest: normalized.digest,
    size: normalized.zip.byteLength,
    name: normalized.name,
    description: normalized.description,
    skill_md: normalized.skillMd,
    html,
    files: JSON.stringify(normalized.files),
    authorId: existing ? existing.owner_id : user.id,
    visibility: opts.visibility ?? "private",
  });

  await env.BUCKET.put(`skills/${normalized.name}/${version}.zip`, normalized.zip, {
    httpMetadata: { contentType: "application/zip" },
  });

  return {
    slug: normalized.name,
    version,
    digest: normalized.digest,
    unchanged: false,
    files: normalized.files,
  };
}
```

**与 spec §11 的一处有意偏离**：spec 描述的是"R2 写成功但 D1 写失败"的场景（即先写 R2）。这里改成**先写 D1 再写 R2**。理由是两种失败模式的可观测性不同：先写库时，R2 写失败会留下一条指向不存在对象的版本记录，用户下载时立刻看到 404，重新发布一次即可修复；先写 R2 时，D1 写失败会留下无人引用的 R2 对象，没有任何地方能发现它。可见的坏状态优于静默的泄漏。R2 的 key 由 `slug` 与 `version` 决定，重发布会覆盖同一个 key，不会累积垃圾。

- [ ] **Step 4: 写上传页面**

`src/views/publish.tsx`：

```tsx
import { Alert, Button, Layout } from "./layout";
import type { UserRow } from "../db/queries";

export function NewSkillPage(props: { user: UserRow; error?: string; markdown?: string }) {
  return (
    <Layout title="发布 skill" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">发布 skill</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <form method="post" action="/new" enctype="multipart/form-data" class="space-y-6">
        <div>
          <span class="block text-sm font-medium text-slate-700">上传压缩包</span>
          <input type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="mt-1 block text-sm" />
          <p class="mt-1 text-xs text-slate-500">
            支持 .zip 与 .tar.gz，压缩包内需包含 SKILL.md（多包一层目录也可以）。上限 2 MB。
          </p>
        </div>
        <div>
          <span class="block text-sm font-medium text-slate-700">或直接粘贴 SKILL.md</span>
          <textarea
            name="markdown"
            rows={16}
            class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
            placeholder={"---\nname: my-skill\ndescription: 一句话说明这个 skill 做什么\n---\n\n# 正文"}
          >
            {props.markdown ?? ""}
          </textarea>
        </div>
        <label class="block max-w-xs">
          <span class="block text-sm font-medium text-slate-700">可见性</span>
          <select name="visibility" class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
            <option value="private">private（仅登录用户可见）</option>
            <option value="public">public（任何人可见和安装）</option>
          </select>
        </label>
        <Button>发布</Button>
      </form>
    </Layout>
  );
}

export function EditSkillPage(props: { user: UserRow; slug: string; markdown: string; error?: string }) {
  return (
    <Layout title={`编辑 ${props.slug}`} user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">编辑 {props.slug}</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <p class="mb-4 text-sm text-slate-500">保存会发布一个新版本，旧版本保留。</p>
      <form method="post" action={`/s/${props.slug}/edit`} enctype="multipart/form-data" class="space-y-4">
        <textarea
          name="markdown"
          rows={24}
          class="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        >
          {props.markdown}
        </textarea>
        <Button>保存为新版本</Button>
      </form>
    </Layout>
  );
}
```

- [ ] **Step 5: 写发布路由**

`src/routes/publish.tsx`：

```tsx
import { Hono } from "hono";
import { canManage, currentUser, userFromApiToken } from "../auth";
import { getSkill, getVersion } from "../db/queries";
import { ForbiddenError, publishBytes } from "../publish";
import { UploadError } from "../skills/normalize";
import type { Env } from "../types";
import { EditSkillPage, NewSkillPage } from "../views/publish";

export const publishRoutes = new Hono<{ Bindings: Env }>();

function visibilityOf(value: unknown): "public" | "private" {
  return value === "public" ? "public" : "private";
}

async function bytesFromForm(body: Record<string, unknown>): Promise<Uint8Array> {
  const file = body.file;
  if (file instanceof File && file.size > 0) {
    return new Uint8Array(await file.arrayBuffer());
  }
  const markdown = typeof body.markdown === "string" ? body.markdown.trim() : "";
  if (markdown) return new TextEncoder().encode(`${markdown}\n`);
  throw new UploadError("请上传压缩包，或在文本框里粘贴 SKILL.md 内容");
}

publishRoutes.get("/new", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  return c.html(<NewSkillPage user={user} />);
});

publishRoutes.post("/new", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  try {
    const bytes = await bytesFromForm(body);
    const result = await publishBytes(c.env, user, bytes, { visibility: visibilityOf(body.visibility) });
    return c.redirect(`/s/${result.slug}`, 302);
  } catch (err) {
    if (err instanceof UploadError) {
      return c.html(<NewSkillPage user={user} error={err.message} markdown={markdown} />, 400);
    }
    if (err instanceof ForbiddenError) {
      return c.html(<NewSkillPage user={user} error={err.message} markdown={markdown} />, 403);
    }
    throw err;
  }
});

publishRoutes.get("/s/:slug/edit", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权编辑这个 skill", 403);
  const latest = await getVersion(c.env.DB, slug, skill.latest_version);
  if (!latest) return c.notFound();
  return c.html(<EditSkillPage user={user} slug={slug} markdown={latest.skill_md} />);
});

publishRoutes.post("/s/:slug/edit", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权编辑这个 skill", 403);
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  try {
    const bytes = new TextEncoder().encode(`${markdown.trim()}\n`);
    await publishBytes(c.env, user, bytes, { expectedSlug: slug });
    return c.redirect(`/s/${slug}`, 302);
  } catch (err) {
    if (err instanceof UploadError) {
      return c.html(<EditSkillPage user={user} slug={slug} markdown={markdown} error={err.message} />, 400);
    }
    throw err;
  }
});

publishRoutes.put("/api/skills/:slug", async (c) => {
  const user = await userFromApiToken(c);
  if (!user) return c.notFound();
  const slug = c.req.param("slug");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const result = await publishBytes(c.env, user, bytes, {
      expectedSlug: slug,
      visibility: visibilityOf(c.req.query("visibility")),
    });
    return c.json(result, result.unchanged ? 200 : 201);
  } catch (err) {
    if (err instanceof UploadError) return c.json({ error: "invalid_upload", message: err.message }, 400);
    if (err instanceof ForbiddenError) return c.json({ error: "forbidden", message: err.message }, 403);
    throw err;
  }
});
```

- [ ] **Step 6: 挂载路由**

在 `src/index.ts` 里 `app.route("/", usersRoutes);` 之后加：

```tsx
import { publishRoutes } from "./routes/publish";
// ...
app.route("/", publishRoutes);
```

- [ ] **Step 7: 运行测试确认通过**

```bash
npx vitest run test/publish.test.ts
```

"publishes an uploaded file" 会因为 `/s/demo-skill` 还不存在而只检查重定向头，这是预期的；详情页在 Task 12 实现。

- [ ] **Step 8: 提交**

```bash
git add src/publish.ts src/routes/publish.tsx src/views/publish.tsx src/index.ts test/publish.test.ts
git commit -m "feat: publish via upload, paste, edit and api"
```

---

### Task 11: Registry 协议与产物下载

**Files:**
- Create: `src/registry.ts`, `src/routes/registry.ts`
- Modify: `src/db/queries.ts`, `src/index.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `listPublishedForIndex` / `getSkill`、Task 8 的 `currentUser`
- Produces:
  - `getVersionByDigest(db: D1Database, slug: string, digest: string): Promise<VersionRow | null>`（加进 `src/db/queries.ts`）
  - `interface IndexEntry { name: string; description: string; type: "archive"; url: string; digest: string }`
  - `buildIndex(rows, baseUrl: string): { $schema: string; skills: IndexEntry[] }`（`src/registry.ts`）
  - `DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"`
  - `registryRoutes: Hono<{ Bindings: Env }>`（`src/routes/registry.ts`）

- [ ] **Step 1: 写失败的测试**

`test/registry.test.ts`：

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { setVisibility } from "../src/db/queries";
import { login, resetDb, seedUser } from "./helpers";

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";
const OTHER_MD = "---\nname: other-skill\ndescription: Another skill.\n---\n\n# Other\n";

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

async function publish(cookie: string, markdown: string, visibility: "public" | "private") {
  const form = new FormData();
  form.set("markdown", markdown);
  form.set("visibility", visibility);
  const res = await SELF.fetch("http://localhost/new", {
    method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`publish failed: ${res.status}`);
}

describe("registry index", () => {
  beforeEach(resetDb);

  it("lists only public skills at the root", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const res = await SELF.fetch("http://localhost/.well-known/agent-skills/index.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const body = await res.json<{ $schema: string; skills: Record<string, unknown>[] }>();
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills.map((s) => s.name)).toEqual(["demo-skill"]);
    for (const entry of body.skills) assertValidEntry(entry);
  });

  it("serves the alias path", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    const res = await SELF.fetch("http://localhost/.well-known/skills/index.json");
    expect(res.status).toBe(200);
  });

  it("includes private skills for a valid install key", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const res = await SELF.fetch(
      `http://localhost/i/${user.install_key}/.well-known/agent-skills/index.json`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Record<string, unknown>[] }>();
    expect(body.skills.map((s) => s.name).sort()).toEqual(["demo-skill", "other-skill"]);
    for (const entry of body.skills) {
      assertValidEntry(entry);
      expect(entry.url as string).toContain(`/i/${user.install_key}/`);
    }
  });

  it("serves the nested index path the CLI uses for single-skill installs", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), OTHER_MD, "private");
    const res = await SELF.fetch(
      `http://localhost/i/${user.install_key}/.well-known/agent-skills/other-skill/.well-known/agent-skills/index.json`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Record<string, unknown>[] }>();
    expect(body.skills.map((s) => s.name)).toContain("other-skill");
  });

  it("returns 404 for an unknown install key", async () => {
    const res = await SELF.fetch("http://localhost/i/deadbeef/.well-known/agent-skills/index.json");
    expect(res.status).toBe(404);
  });

  it("does not leak a skill after it is made private again", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    await setVisibility(env.DB, "demo-skill", "private");
    const res = await SELF.fetch("http://localhost/.well-known/agent-skills/index.json");
    const body = await res.json<{ skills: unknown[] }>();
    expect(body.skills).toEqual([]);
  });
});

describe("artifact download", () => {
  beforeEach(resetDb);

  it("serves bytes whose sha256 equals the digest in the index", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");

    const index = await (
      await SELF.fetch("http://localhost/.well-known/agent-skills/index.json")
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
    const { user, password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), OTHER_MD, "private");
    const index = await (
      await SELF.fetch(`http://localhost/i/${user.install_key}/.well-known/agent-skills/index.json`)
    ).json<{ skills: Array<{ url: string; digest: string }> }>();
    const entry = index.skills[0];

    const viaKey = await SELF.fetch(entry.url);
    expect(viaKey.status).toBe(200);
    expect(viaKey.headers.get("Cache-Control")).toBe("private, no-store");

    const withoutKey = entry.url.replace(`/i/${user.install_key}`, "");
    expect((await SELF.fetch(withoutKey)).status).toBe(404);
  });

  it("returns 404 for a digest that does not match any version", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    const res = await SELF.fetch(`http://localhost/d/demo-skill/${"0".repeat(64)}.zip`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/registry.test.ts
```

预期：失败，路由不存在。

- [ ] **Step 3: 加查询函数**

在 `src/db/queries.ts` 末尾追加：

```ts
export function getVersionByDigest(
  db: D1Database,
  slug: string,
  digest: string,
): Promise<VersionRow | null> {
  return db
    .prepare("SELECT * FROM versions WHERE slug = ? AND digest = ?")
    .bind(slug, digest)
    .first<VersionRow>();
}
```

- [ ] **Step 4: 写 index 构建器**

`src/registry.ts`：

```ts
import { isValidDescription, isValidSkillName } from "./skills/frontmatter";

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export interface IndexEntry {
  name: string;
  description: string;
  type: "archive";
  url: string;
  digest: string;
}

export interface IndexSource {
  slug: string;
  description: string;
  digest: string;
}

/**
 * baseUrl 形如 https://host 或 https://host/i/<key>，产物地址直接拼在它后面。
 * 不满足 CLI 校验规则的条目会被丢弃 —— 宁可少一条，也不要让 CLI 拿到半个坏 index。
 */
export function buildIndex(
  rows: IndexSource[],
  baseUrl: string,
): { $schema: string; skills: IndexEntry[] } {
  const skills: IndexEntry[] = [];
  for (const row of rows) {
    if (!isValidSkillName(row.slug)) continue;
    if (!isValidDescription(row.description)) continue;
    if (!DIGEST_RE.test(row.digest)) continue;
    skills.push({
      name: row.slug,
      description: row.description,
      type: "archive",
      url: `${baseUrl}/d/${row.slug}/${row.digest.slice("sha256:".length)}.zip`,
      digest: row.digest,
    });
  }
  return { $schema: DISCOVERY_SCHEMA, skills };
}
```

- [ ] **Step 5: 写路由**

`src/routes/registry.ts`：

```ts
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
```

**不要给这两个 index 路由套 try/catch 返回空 index。** 数据库出错时必须让异常冒泡到 `app.onError`（Task 12 加）并返回 5xx —— CLI 对非 200 会跳过并尝试下一个候选地址，而一个 `skills: []` 的 200 会被它当成"这个 registry 是空的"，用户只会看到"没有找到任何 skill"而不是错误。

- [ ] **Step 6: 挂载路由**

在 `src/index.ts` 中，**在 `usersRoutes` 与 `publishRoutes` 之前**挂载 registry，避免 `/i/:key/*` 被其他通配路由抢走：

```tsx
import { registryRoutes } from "./routes/registry";
// ...
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
```

- [ ] **Step 7: 运行测试确认通过**

```bash
npx vitest run test/registry.test.ts
```

预期：全部通过。若 "serves the nested index path" 失败，检查 `/i/:key/*` 是否被更早注册的路由拦截。

- [ ] **Step 8: 提交**

```bash
git add src/registry.ts src/routes/registry.ts src/db/queries.ts src/index.ts test/registry.test.ts
git commit -m "feat: well-known discovery index and artifact download"
```

---

### Task 12: 浏览界面与 Tailwind

**Files:**
- Create: `src/app.css`, `src/views/skills.tsx`, `src/routes/skills.tsx`
- Modify: `src/index.ts`
- Test: `test/skills.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `listSkills` / `getSkill` / `getVersion` / `listVersions` / `setVisibility` / `deleteSkill`、Task 8 的 `currentUser` / `canManage`
- Produces:
  - `IndexPage(props: { user: UserRow | null; skills: Array<SkillRow & { author: string }>; q: string; origin: string })`
  - `SkillPage(props: { user: UserRow | null; skill: SkillRow & { author: string }; version: VersionRow; versions: VersionRow[]; origin: string; canManage: boolean })`
  - `skillsRoutes: Hono<{ Bindings: Env }>`

- [ ] **Step 1: 写失败的测试**

`test/skills.test.ts`：

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { login, resetDb, seedUser } from "./helpers";

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo Heading\n";
const OTHER_MD = "---\nname: other-skill\ndescription: Another skill.\n---\n\n# Other\n";

async function publish(cookie: string, markdown: string, visibility: "public" | "private") {
  const form = new FormData();
  form.set("markdown", markdown);
  form.set("visibility", visibility);
  const res = await SELF.fetch("http://localhost/new", {
    method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
}

const post = (path: string, cookie: string) =>
  SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
    redirect: "manual",
  });

describe("GET /", () => {
  beforeEach(resetDb);

  it("shows only public skills to anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const html = await (await SELF.fetch("http://localhost/")).text();
    expect(html).toContain("demo-skill");
    expect(html).not.toContain("other-skill");
  });

  it("shows private skills to logged-in users", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, OTHER_MD, "private");
    const html = await (await SELF.fetch("http://localhost/", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("other-skill");
  });

  it("filters by query", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");
    const html = await (await SELF.fetch("http://localhost/?q=other")).text();
    expect(html).toContain("other-skill");
    expect(html).not.toContain(">demo-skill<");
  });
});

describe("GET /s/:slug", () => {
  beforeEach(resetDb);

  it("renders the stored html and the install command", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch("http://localhost/s/demo-skill", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Demo Heading");
    expect(html).toContain("SKILL.md");
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  it("shows the public install command to anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    const html = await (await SELF.fetch("http://localhost/s/demo-skill")).text();
    expect(html).toContain("npx skills add");
    expect(html).not.toContain("/i/");
  });

  it("hides a private skill from anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), OTHER_MD, "private");
    expect((await SELF.fetch("http://localhost/s/other-skill")).status).toBe(404);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await SELF.fetch("http://localhost/s/nope")).status).toBe(404);
  });
});

describe("downloads", () => {
  beforeEach(resetDb);

  it("serves the latest version as an attachment", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    const res = await SELF.fetch("http://localhost/s/demo-skill/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("demo-skill.zip");
  });

  it("serves a specific version", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch("http://localhost/s/demo-skill/v/1/download");
    expect(res.status).toBe(200);
  });

  it("refuses to serve a private skill to anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), OTHER_MD, "private");
    expect((await SELF.fetch("http://localhost/s/other-skill/download")).status).toBe(404);
  });
});

describe("visibility and deletion", () => {
  beforeEach(resetDb);

  it("toggles visibility", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "private");
    await post("/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
    await post("/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("deletes the skill and its r2 objects", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "private");
    expect(await env.BUCKET.get("skills/demo-skill/1.zip")).not.toBeNull();
    const res = await post("/s/demo-skill/delete", cookie);
    expect(res.status).toBe(302);
    expect(await getSkill(env.DB, "demo-skill")).toBeNull();
    expect(await env.BUCKET.get("skills/demo-skill/1.zip")).toBeNull();
  });

  it("stops a member touching another user's skill", async () => {
    const alice = await seedUser({ username: "alice" });
    await publish(await login("alice", alice.password), GOOD_MD, "private");
    const bob = await seedUser({ username: "bob", role: "member" });
    const cookie = await login("bob", bob.password);
    expect((await post("/s/demo-skill/visibility", cookie)).status).toBe(403);
    expect((await post("/s/demo-skill/delete", cookie)).status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/skills.test.ts
```

预期：失败，路由不存在。

- [ ] **Step 3: 写 Tailwind 入口并构建**

`src/app.css`：

```css
@import "tailwindcss";

@source "./**/*.tsx";

/* 渲染后的 SKILL.md 正文。不引 @tailwindcss/typography，手写这几条够用了。 */
.skill-doc h1 { @apply mt-6 mb-2 text-lg font-semibold; }
.skill-doc h2 { @apply mt-5 mb-2 text-base font-semibold; }
.skill-doc h3 { @apply mt-4 mb-1 text-sm font-semibold; }
.skill-doc p  { @apply my-2 text-sm leading-6 text-slate-700; }
.skill-doc ul { @apply my-2 list-disc pl-5 text-sm text-slate-700; }
.skill-doc ol { @apply my-2 list-decimal pl-5 text-sm text-slate-700; }
.skill-doc a  { @apply text-blue-700 underline; }
.skill-doc code { @apply rounded bg-slate-100 px-1 py-0.5 font-mono text-xs; }
.skill-doc pre { @apply my-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100; }
.skill-doc pre code { @apply bg-transparent p-0 text-slate-100; }
.skill-doc table { @apply my-3 w-full text-sm; }
.skill-doc th, .skill-doc td { @apply border-b border-slate-200 px-2 py-1 text-left; }
```

```bash
npm run build
```

确认 `public/app.css` 生成。

- [ ] **Step 4: 写页面**

`src/views/skills.tsx`：

```tsx
import { Layout } from "./layout";
import type { SkillRow, UserRow, VersionRow } from "../db/queries";

function InstallBlock(props: { origin: string; slug: string; user: UserRow | null; isPublic: boolean }) {
  const base = props.user ? `${props.origin}/i/${props.user.install_key}` : props.origin;
  const url = `${base}/.well-known/agent-skills/${props.slug}`;
  return (
    <div>
      <pre class="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-slate-100">npx skills add {url}</pre>
      {!props.user && !props.isPublic ? null : (
        <p class="mt-1 text-xs text-slate-500">
          {props.user
            ? "这条命令带着你的 install key，可以装私有 skill。"
            : "这是公开地址，任何人都能用。"}
        </p>
      )}
    </div>
  );
}

export function IndexPage(props: {
  user: UserRow | null;
  skills: Array<SkillRow & { author: string }>;
  q: string;
  origin: string;
}) {
  return (
    <Layout title="全部 skill" user={props.user}>
      <form method="get" action="/" class="mb-6 flex gap-2">
        <input
          name="q"
          value={props.q}
          placeholder="搜索名称、简介或正文"
          class="flex-1 rounded border border-slate-300 px-3 py-2"
        />
        <button type="submit" class="rounded bg-slate-900 px-4 py-2 text-sm text-white">搜索</button>
      </form>

      {props.user ? (
        <div class="mb-6">
          <h2 class="mb-1 text-sm font-medium text-slate-700">一次装上全部</h2>
          <pre class="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-slate-100">npx skills add {props.origin}/i/{props.user.install_key}</pre>
        </div>
      ) : null}

      {props.skills.length === 0 ? (
        <p class="text-sm text-slate-500">
          {props.q ? "没有匹配的 skill。" : "还没有任何 skill。"}
        </p>
      ) : (
        <ul class="divide-y divide-slate-200">
          {props.skills.map((s) => (
            <li class="py-3">
              <div class="flex items-baseline gap-2">
                <a href={`/s/${s.slug}`} class="font-medium text-slate-900 hover:underline">{s.slug}</a>
                {s.visibility === "private" ? (
                  <span class="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600">private</span>
                ) : (
                  <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">public</span>
                )}
                <span class="text-xs text-slate-400">v{s.latest_version} · {s.author}</span>
              </div>
              <p class="mt-1 text-sm text-slate-600">{s.description}</p>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export function SkillPage(props: {
  user: UserRow | null;
  skill: SkillRow & { author: string };
  version: VersionRow;
  versions: VersionRow[];
  origin: string;
  canManage: boolean;
}) {
  const files = JSON.parse(props.version.files) as Array<{ path: string; size: number }>;
  return (
    <Layout title={props.skill.slug} user={props.user}>
      <div class="mb-2 flex items-baseline gap-2">
        <h1 class="text-xl font-semibold">{props.skill.slug}</h1>
        <span class="text-xs text-slate-400">
          v{props.version.version} · {props.skill.author} · {props.skill.visibility}
        </span>
      </div>
      <p class="mb-6 text-sm text-slate-600">{props.version.description}</p>

      <div class="mb-6 space-y-2">
        <InstallBlock
          origin={props.origin}
          slug={props.skill.slug}
          user={props.user}
          isPublic={props.skill.visibility === "public"}
        />
        <div class="flex flex-wrap gap-2 text-sm">
          <a href={`/s/${props.skill.slug}/download`} class="rounded border border-slate-300 px-3 py-1.5">
            下载 zip
          </a>
          {props.canManage ? (
            <>
              <a href={`/s/${props.skill.slug}/edit`} class="rounded border border-slate-300 px-3 py-1.5">
                编辑
              </a>
              <form method="post" action={`/s/${props.skill.slug}/visibility`}>
                <button type="submit" class="rounded border border-slate-300 px-3 py-1.5">
                  {props.skill.visibility === "public" ? "改为 private" : "改为 public"}
                </button>
              </form>
              <form method="post" action={`/s/${props.skill.slug}/delete`}>
                <button type="submit" class="rounded border border-red-300 px-3 py-1.5 text-red-700">
                  删除
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>

      <section class="mb-6">
        <h2 class="mb-2 text-sm font-medium text-slate-700">文件</h2>
        <ul class="text-sm text-slate-600">
          {files.map((f) => (
            <li class="flex justify-between border-b border-slate-100 py-1">
              <span class="font-mono">{f.path}</span>
              <span class="text-slate-400">{f.size} B</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="mb-6">
        <h2 class="mb-2 text-sm font-medium text-slate-700">版本</h2>
        <ul class="text-sm text-slate-600">
          {props.versions.map((v) => (
            <li class="flex items-center gap-3 border-b border-slate-100 py-1">
              <a href={`/s/${props.skill.slug}?v=${v.version}`} class="hover:underline">v{v.version}</a>
              <span class="text-slate-400">{new Date(v.created_at).toISOString().slice(0, 16).replace("T", " ")}</span>
              <span class="flex-1" />
              <a href={`/s/${props.skill.slug}/v/${v.version}/download`} class="hover:underline">下载</a>
            </li>
          ))}
        </ul>
      </section>

      <article class="skill-doc" dangerouslySetInnerHTML={{ __html: props.version.html }} />
    </Layout>
  );
}
```

`dangerouslySetInnerHTML` 在这里是安全的：`version.html` 是发布时用 HTMLRewriter 白名单净化过的产物（Task 7），不是用户输入的原样回显。

- [ ] **Step 5: 写路由**

`src/routes/skills.tsx`：

```tsx
import { Hono } from "hono";
import { canManage, currentUser } from "../auth";
import type { Ctx } from "../auth";
import {
  deleteSkill, getSkill, getVersion, listSkills, listVersions, setVisibility,
} from "../db/queries";
import type { Env } from "../types";
import { IndexPage, SkillPage } from "../views/skills";

export const skillsRoutes = new Hono<{ Bindings: Env }>();

skillsRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  const skills = await listSkills(c.env.DB, { includePrivate: user !== null, q: q || undefined });
  return c.html(<IndexPage user={user} skills={skills} q={q} origin={new URL(c.req.url).origin} />);
});

skillsRoutes.get("/s/:slug", async (c) => {
  const user = await currentUser(c);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (skill.visibility === "private" && !user) return c.notFound();

  const requested = Number(c.req.query("v") ?? skill.latest_version);
  const version = await getVersion(c.env.DB, slug, Number.isInteger(requested) ? requested : skill.latest_version);
  if (!version) return c.notFound();

  const author = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
    .bind(skill.owner_id)
    .first<{ username: string }>();

  return c.html(
    <SkillPage
      user={user}
      skill={{ ...skill, author: author?.username ?? "unknown" }}
      version={version}
      versions={await listVersions(c.env.DB, slug)}
      origin={new URL(c.req.url).origin}
      canManage={user ? canManage(user, skill) : false}
    />,
  );
});

async function download(c: Ctx, versionNumber?: number) {
  const user = await currentUser(c);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (skill.visibility === "private" && !user) return c.notFound();

  const version = await getVersion(c.env.DB, slug, versionNumber ?? skill.latest_version);
  if (!version) return c.notFound();

  const object = await c.env.BUCKET.get(version.r2_key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Cache-Control": skill.visibility === "public" ? "public, max-age=300" : "private, no-store",
    },
  });
}

skillsRoutes.get("/s/:slug/download", (c) => download(c));

skillsRoutes.get("/s/:slug/v/:version/download", (c) => {
  const n = Number(c.req.param("version"));
  if (!Number.isInteger(n) || n < 1) return c.notFound();
  return download(c, n);
});

skillsRoutes.post("/s/:slug/visibility", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权修改这个 skill", 403);
  await setVisibility(c.env.DB, slug, skill.visibility === "public" ? "private" : "public");
  return c.redirect(`/s/${slug}`, 302);
});

skillsRoutes.post("/s/:slug/delete", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权删除这个 skill", 403);
  const keys = await deleteSkill(c.env.DB, slug);
  await Promise.all(keys.map((key) => c.env.BUCKET.delete(key)));
  return c.redirect("/", 302);
});
```

- [ ] **Step 6: 挂载路由**

`src/index.ts` 最终形态：

```tsx
import { Hono } from "hono";
import { publishRoutes } from "./routes/publish";
import { registryRoutes } from "./routes/registry";
import { skillsRoutes } from "./routes/skills";
import { usersRoutes } from "./routes/users";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  console.error("unhandled", err);
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.path.startsWith("/api/") || accepts.includes("application/json")) {
    return c.json({ error: "internal_error", message: "服务内部错误" }, 500);
  }
  return c.html("<h1>服务内部错误</h1>", 500);
});

export default app;
```

- [ ] **Step 7: 运行全部测试**

```bash
npm test && npm run typecheck
```

预期：全部通过，无类型错误。

- [ ] **Step 8: 提交**

```bash
git add src/app.css src/views/skills.tsx src/routes/skills.tsx src/index.ts test/skills.test.ts public/.gitkeep
git commit -m "feat: browse, search, download and manage skills"
```

---

### Task 13: 真实 CLI 契约测试与部署文档

**Files:**
- Create: `scripts/verify-cli.mjs`, `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: `npm run verify:cli`

这一任务是整个项目"兼容 skills.sh"这个承诺的唯一可信证明。在它通过之前，不得声称兼容。

- [ ] **Step 1: 准备本地环境**

```bash
npx wrangler d1 migrations apply skillsgist --local
```

- [ ] **Step 2: 写契约测试脚本**

`scripts/verify-cli.mjs`：

```js
#!/usr/bin/env node
// 用真实的 `npx skills` 验证 registry 协议兼容性。
// 起一个本地 wrangler dev，发布一个 skill，然后让 CLI 装它，最后检查文件是否落地。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 8788;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = "verify-cli-password";

function log(msg) {
  process.stdout.write(`[verify-cli] ${msg}\n`);
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev 未在超时时间内就绪");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    child.on("error", reject);
  });
}

function findFile(root, relative) {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (full.endsWith(relative)) return full;
    }
  }
  return null;
}

const server = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--local"],
  { stdio: ["ignore", "inherit", "inherit"] },
);

let exitCode = 1;
try {
  await waitForServer();
  log("wrangler dev 已就绪");

  // 1. 建管理员并登录
  const setup = await fetch(`${ORIGIN}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  if (setup.status !== 302 && setup.status !== 404) {
    throw new Error(`/setup 返回了 ${setup.status}`);
  }

  const loginRes = await fetch(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "verifier", password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("登录未返回会话 cookie");
  log("已登录");

  // 2. 取 api token 与 install key
  const tokenHtml = await (
    await fetch(`${ORIGIN}/me/api-token`, { method: "POST", headers: { Cookie: cookie } })
  ).text();
  const token = /sgt_[a-f0-9]{32}/.exec(tokenHtml)?.[0];
  if (!token) throw new Error("未能生成 api token");

  const meHtml = await (await fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
  const installKey = /\/i\/([a-f0-9]{32})/.exec(meHtml)?.[1];
  if (!installKey) throw new Error("未能读取 install key");
  log(`install key: ${installKey.slice(0, 8)}…`);

  // 3. 发布一个私有 skill
  const fixture = readFileSync(new URL("../test/fixtures/wrapped.zip", import.meta.url));
  const publish = await fetch(`${ORIGIN}/api/skills/demo-skill`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
    body: fixture,
  });
  if (publish.status !== 201 && publish.status !== 200) {
    throw new Error(`发布失败：${publish.status} ${await publish.text()}`);
  }
  log("已发布 demo-skill");

  // 4. 校验 index 中的 digest 与产物字节一致
  const index = await (
    await fetch(`${ORIGIN}/i/${installKey}/.well-known/agent-skills/index.json`)
  ).json();
  const entry = index.skills.find((s) => s.name === "demo-skill");
  if (!entry) throw new Error("index 中找不到 demo-skill");
  const artifact = new Uint8Array(await (await fetch(entry.url)).arrayBuffer());
  const hash = await crypto.subtle.digest("SHA-256", artifact);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (`sha256:${hex}` !== entry.digest) throw new Error("产物 digest 与 index 不一致");
  log("digest 校验通过");

  // 5. 用真实的 npx skills 安装到一个隔离的 HOME，避免污染本机 skills 目录
  const home = mkdtempSync(join(tmpdir(), "skillsgist-verify-"));
  await run(
    "npx",
    ["--yes", "skills", "add", `${ORIGIN}/i/${installKey}`, "-g", "-y", "-s", "demo-skill", "--copy"],
    { env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") } },
  );

  const installed = findFile(home, join("demo-skill", "SKILL.md"));
  if (!installed) throw new Error(`npx skills 未把 demo-skill 装到 ${home}`);
  const content = readFileSync(installed, "utf8");
  if (!content.includes("name: demo-skill")) throw new Error("装上的 SKILL.md 内容不对");
  log(`安装成功：${installed}`);

  // 6. 单个 skill 的安装路径也要能用
  const home2 = mkdtempSync(join(tmpdir(), "skillsgist-verify-single-"));
  await run(
    "npx",
    ["--yes", "skills", "add", `${ORIGIN}/i/${installKey}/.well-known/agent-skills/demo-skill`, "-g", "-y", "--copy"],
    { env: { ...process.env, HOME: home2, USERPROFILE: home2, XDG_CONFIG_HOME: join(home2, ".config") } },
  );
  if (!findFile(home2, join("demo-skill", "SKILL.md"))) {
    throw new Error("单 skill 安装路径不生效");
  }
  log("单 skill 安装路径通过");

  log("全部契约检查通过");
  exitCode = 0;
} catch (err) {
  process.stderr.write(`[verify-cli] 失败：${err.message}\n`);
} finally {
  server.kill("SIGTERM");
}

process.exit(exitCode);
```

- [ ] **Step 3: 加 npm script**

```bash
npm pkg set scripts.verify:cli="node scripts/verify-cli.mjs"
npm pkg set scripts.fixtures="./scripts/make-fixtures.sh"
```

- [ ] **Step 4: 运行契约测试**

```bash
npm run build
npm run verify:cli
```

预期：输出以 `[verify-cli] 全部契约检查通过` 结束，退出码 0。

若失败，按以下顺序排查：
1. `npx wrangler d1 migrations apply skillsgist --local` 是否执行过
2. `/i/<key>/.well-known/agent-skills/index.json` 手工 curl 是否返回合法 JSON
3. index 里的 `url` 是否是绝对地址且带 `/i/<key>` 前缀
4. 手工下载产物、`shasum -a 256` 对比 `digest`
5. 手工 `unzip -l` 确认根目录就是 `SKILL.md` 而不是 `demo-skill/SKILL.md`

- [ ] **Step 5: 写 README**

`README.md`：

```markdown
# skillsgist

跑在 Cloudflare 上的极简私有 Agent Skills registry。网页管理，`npx skills` 一键安装。

## 它做什么

- 网页上传 / 粘贴 / 编辑 skill，支持 `.zip`、`.tar.gz` 与单个 `SKILL.md`
- 默认私有，单个 skill 可以按需公开
- 兼容 [skills.sh](https://skills.sh) 生态的发现协议，不需要自研 CLI

## 安装 skill

```bash
# 装上你可见的全部 skill（install key 在 /me 页面）
npx skills add https://<你的域名>/i/<install_key>

# 只装一个
npx skills add https://<你的域名>/i/<install_key>/.well-known/agent-skills/<skill-name>

# 公开的 skill 不需要 key
npx skills add https://<你的域名>
```

## 发布 skill

网页上 `/new` 拖个压缩包，或者：

```bash
cd my-skill
zip -r - . | curl -X PUT --data-binary @- \
  -H "Authorization: Bearer $SKILLSGIST_TOKEN" \
  -H "Content-Type: application/zip" \
  https://<你的域名>/api/skills/my-skill
```

API token 在 `/me` 页面按需生成。它只走 header，不会进入 URL。

## 首次部署

```bash
npm install

# 建资源
npx wrangler d1 create skillsgist        # 把输出的 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create skillsgist

# 建表
npx wrangler d1 migrations apply skillsgist --remote

# 设会话密钥
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET

# 部署
npm run deploy
```

部署完访问 `https://<你的域名>/setup` 创建第一个管理员。该页面在有用户之后自动失效。

绑自定义域名：在 `wrangler.jsonc` 里加 `routes`，重新 `npm run deploy` 即可，不需要改代码。

## 本地开发

```bash
npx wrangler d1 migrations apply skillsgist --local
npm run dev          # tailwind --watch + wrangler dev
npm test             # 单元与集成测试
npm run verify:cli   # 用真实的 npx skills 跑一遍契约测试
npm run typecheck
```

## 两个需要知道的约束

**install key 会出现在 URL 里。** `npx skills` 发请求时不带任何自定义 header，所以私有安装的凭据只能编码在路径中。这串 key 只有安装权限 —— 拿到它的人不能登录、不能发布、不能删除 —— 并且可以在 `/me` 页面一键重置。

**上传限额是 2 MB / 解包 8 MB / 200 个文件。** 这是为了适配 Workers Free 套餐单次请求 10 ms 的 CPU 上限。升级到 Workers Paid 之后，可以调高 `src/skills/normalize.ts` 里的三个常量和 `src/auth.ts` 里的 `PBKDF2_ITERATIONS`。

## 设计文档

- 设计：`docs/superpowers/specs/2026-09-21-skillsgist-design.md`
- 实现计划：`docs/superpowers/plans/2026-09-21-skillsgist.md`
```

- [ ] **Step 6: 最终验证**

```bash
npm test && npm run typecheck && npm run verify:cli
```

三条全部通过才算完成。

- [ ] **Step 7: 提交**

```bash
git add scripts/verify-cli.mjs README.md package.json
git commit -m "test: real npx skills contract verification, add README"
```
