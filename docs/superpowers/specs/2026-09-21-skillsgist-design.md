# skillsgist 设计文档

- 日期：2026-09-21
- 状态：待评审
- 一句话：跑在 Cloudflare 上的极简私有 Agent Skills registry，网页管理，`npx skills` 一键安装。

## 1. 背景与目标

团队内部积累的 Agent Skills（`SKILL.md` + `references/` + `scripts/`）目前没有统一存放和分发的地方。skillsgist 要解决三件事：

1. **集中存放**：一个网页界面，能上传、浏览、下载完整的 skill 包
2. **私有优先，可选公开**：默认私有，单个 skill 可以按需公开给任何人
3. **一键安装**：不自研 CLI，直接兼容社区已有的 `npx skills`（skills.sh 生态）

成功标准：团队成员执行 `npx skills add https://<域名>/i/<install_key>` 能装上全部私有 skill；陌生人执行 `npx skills add https://<域名>` 只能装到公开的那些。

## 2. 非目标（YAGNI）

明确不做：OAuth / 第三方登录、语义化版本与依赖解析、skill 之间的依赖关系、安装量统计与排行、安全扫描集成、组织与团队（只有两种用户角色）、独立的全文检索引擎（用 D1 的 `LIKE`）、浏览器端 hydration 或 SPA。

## 3. 关键外部约束

以下均通过阅读 `skills` npm 包 v1.5.18 的发布产物（`dist/cli.mjs`）确认，非推测：

### 3.1 发现协议

CLI 收到 `https://host/<basePath>` 后，依次尝试：

1. `https://host/<basePath>/.well-known/agent-skills/index.json`
2. `https://host/.well-known/agent-skills/index.json`（basePath 非空时的回退）
3. 以上两条的 `.well-known/skills/` 别名

取第一个返回 200 且能解析出至少一个合法条目的作为结果。

### 3.2 index.json 格式（Discovery v0.2.0）

```json
{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "my-skill",
      "description": "……",
      "type": "archive",
      "url": "https://host/d/my-skill/<digest>.zip",
      "digest": "sha256:<64 位小写十六进制>"
    }
  ]
}
```

条目校验规则（任一不满足该条目被**静默丢弃**）：

- `name`：`^[a-z0-9-]+$`，长度 1–64，不以 `-` 开头或结尾，不含 `--`
- `description`：非空字符串，长度 ≤ 1024
- `type`：只能是 `"skill-md"` 或 `"archive"`
- `url`：非空，相对 index.json 的 URL 解析
- `digest`：必须匹配 `^sha256:[a-f0-9]{64}$`，且**必须等于实际下载字节的 sha256**

### 3.3 压缩包约束

- 支持 `.zip` 与 `.tar.gz`；按 `Content-Type`、URL 后缀、魔数三者任一识别
- **压缩包根目录必须有 `SKILL.md`**，zip 和 tar.gz 都一样
- 路径不得以 `/` 或盘符开头，不得含 `\`、`..`、`.`、NUL
- 不支持软链接与硬链接条目（tar 的 typeflag 1/2、zip 外部属性里的 symlink 位）
- zip 只支持压缩方法 0（stored）与 8（deflate）
- 上限：解包后 50 MB、1000 个文件

### 3.4 鉴权限制

CLI 请求 index 与产物时使用裸 `fetch(url)`，**不携带任何自定义 header**（`GITHUB_TOKEN` 只用于 GitHub 源）。

**推论：私有 skill 的安装凭据只能编码在 URL 中。** 这是本设计采用 `/i/<install_key>/` 路径前缀的唯一原因。

### 3.5 单 skill 安装的路径行为

`npx skills add https://host/i/<key>/.well-known/agent-skills/my-skill` 会先请求
`https://host/i/<key>/.well-known/agent-skills/my-skill/.well-known/agent-skills/index.json`。
若该请求 404，回退到的是**不带 key 的根路径** index，私有 skill 就找不到了。

因此服务端必须用通配路由接住 `/i/:key/**/.well-known/agent-skills/index.json`，统一返回该 key 可见的 index。

## 4. 架构总览

```
浏览器 ──┐
         ├─► Worker (Hono + hono/jsx SSR) ──┬─► D1   元数据 / SKILL.md 正文 / 渲染后 HTML / 用户
npx skills ┘         │                       └─► R2   规范化后的 .zip 字节
                     └─► Workers Assets（Tailwind 构建产物 app.css）
```

单 Worker 承担全部职责，无队列、无 Durable Objects、无外部服务。

**贯穿全局的不变式**：R2 中存储的 zip 字节 == 网页下载的字节 == index.json 中 digest 所对应的字节。三者同源，CLI 的 digest 校验就不可能失败。

## 5. 用户与鉴权

### 5.1 用户模型

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,      -- ^[a-z0-9-]{2,32}$
  password_hash TEXT NOT NULL,             -- pbkdf2$<iterations>$<salt_b64>$<hash_b64>
  role          TEXT NOT NULL,             -- 'admin' | 'member'
  install_key   TEXT NOT NULL UNIQUE,      -- 32 位十六进制，只读权限
  api_token_hash TEXT,                     -- 可空；写权限，仅走 header
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
```

### 5.2 密码

- 算法：WebCrypto 原生 PBKDF2-HMAC-SHA256（Workers 无 bcrypt / argon2）
- **迭代数 10,000**，随机 16 字节 salt，派生 32 字节
- 迭代数写在哈希串里，将来升级套餐后可无痛提高，老密码在下次登录时按需重算并回写
- 因迭代数偏低，**强制密码长度 ≥ 12 个字符**作为补偿
- 登录失败不区分「用户不存在」与「密码错误」，统一返回同一条提示

### 5.3 会话

Hono 的 signed cookie（`setSignedCookie` / `getSignedCookie`，密钥来自 `SESSION_SECRET`），载荷 `{ uid, exp }`，有效期 30 天，`HttpOnly; Secure; SameSite=Lax; Path=/`。不建 sessions 表。

### 5.4 首次部署

`GET /setup` 在 `users` 表为空时提供建号表单，创建第一个 `admin` 后该路由对所有后续请求返回 404。无需运行任何脚本。

### 5.5 install_key

- 每个用户一枚，32 位十六进制随机串，**只读权限**
- 用途：拼进 CLI 的 URL，`https://<域名>/i/<install_key>`
- `/me` 页面展示一条可直接复制的完整命令，并提供「重置」按钮
- 泄漏后果有界：只能安装 skill，不能登录网页、不能发布、不能删除
- 服务端按 `install_key` 明文建唯一索引查询（它不是身份凭据，无需哈希存储；需要即时失效能力，哈希反而妨碍不了什么）

### 5.6 api_token（可选，用于 curl / CI 发布）

- 默认不存在，用户在 `/me` 点击生成，明文只展示一次，数据库存 sha256
- **写权限**，仅通过 `Authorization: Bearer <token>` 传递，永不进入 URL
- 可随时吊销与重新生成

### 5.7 权限矩阵

| 操作 | 匿名 | member | admin |
|---|---|---|---|
| 浏览 / 下载 / 安装 public skill | ✓ | ✓ | ✓ |
| 浏览 / 下载 / 安装 private skill | ✗ | ✓ | ✓ |
| 发布新 skill | ✗ | ✓ | ✓ |
| 编辑 / 删除 / 改可见性（自己的） | ✗ | ✓ | ✓ |
| 编辑 / 删除 / 改可见性（他人的） | ✗ | ✗ | ✓ |
| 管理用户 | ✗ | ✗ | ✓ |

## 6. 数据模型

`users` 表见 5.1 节，此处是其余两张表。

```sql
CREATE TABLE skills (
  slug           TEXT PRIMARY KEY,   -- 等于 SKILL.md frontmatter 的 name
  description    TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'public'
  owner_id       TEXT NOT NULL REFERENCES users(id),
  latest_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_skills_visibility ON skills(visibility);

CREATE TABLE versions (
  slug        TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  version     INTEGER NOT NULL,      -- 1, 2, 3 …… 单调递增
  digest      TEXT NOT NULL,         -- sha256:<hex>，规范化 zip 的哈希
  size        INTEGER NOT NULL,      -- zip 字节数
  name        TEXT NOT NULL,         -- 发布当时的 frontmatter name
  description TEXT NOT NULL,
  skill_md    TEXT NOT NULL,         -- SKILL.md 原文，用于搜索与再编辑
  html        TEXT NOT NULL,         -- 发布时渲染并净化后的 HTML
  files       TEXT NOT NULL,         -- JSON: [{ "path": "...", "size": 123 }]
  r2_key      TEXT NOT NULL,         -- skills/<slug>/<version>.zip
  author_id   TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);
```

设计要点：

- **`slug` 直接取 frontmatter 的 `name`**，保证网页上的名字与 CLI 装到本地的目录名完全一致，不存在两套命名体系
- 历史版本永久保留（R2 便宜），网页可回看和下载任意版本
- `html` 在发布时算好存下来，页面访问只读库，不做 markdown 渲染（见第 12 节的 CPU 约束）

## 7. 路由表

### 7.1 网页（SSR）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/?q=<关键词>` | 公开 | skill 列表 + 搜索（D1 `LIKE` 匹配 slug、description、SKILL.md 正文）。匿名只见 public，登录后见全部，私有带标记 |
| GET | `/s/:slug` | 按可见性 | 详情：渲染后的 SKILL.md、文件树、版本历史、安装命令、下载按钮 |
| GET/POST | `/s/:slug/edit` | 所有者或 admin | 文本框预填当前 SKILL.md，保存即发布新版本 |
| GET/POST | `/new` | 登录用户 | 上传：zip / tar.gz 文件，或直接粘贴 SKILL.md 文本 |
| POST | `/s/:slug/visibility` | 所有者或 admin | 切换 public / private |
| POST | `/s/:slug/delete` | 所有者或 admin | 删除 skill 及其全部版本与 R2 对象 |
| GET/POST | `/login` · POST `/logout` | 公开 | 用户名密码登录 |
| GET | `/setup` | 仅 users 表为空时 | 创建第一个管理员 |
| GET/POST | `/me` | 登录用户 | 改密码、查看/重置 install_key、生成/吊销 api_token |
| GET/POST | `/admin/users` | admin | 建号、改角色、重置密码、删号 |

### 7.2 下载

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/s/:slug/download` | 最新版 zip，按会话鉴权 |
| GET | `/s/:slug/v/:n/download` | 指定版本，按会话鉴权 |
| GET | `/d/:slug/:digest.zip` | 给 CLI 的公开产物地址，仅 public skill |
| GET | `/i/:key/d/:slug/:digest.zip` | 给 CLI 的私有产物地址 |

产物响应头：`Content-Type: application/zip`、`Content-Disposition: attachment; filename="<slug>.zip"`。

缓存策略需要区分对待：

- `/d/...`（公开产物）：`Cache-Control: public, max-age=300`
- `/i/<key>/d/...`（私有产物）：`Cache-Control: private, no-store`

公开产物**不使用** `immutable` 或长 `max-age`。URL 虽然带 digest、内容确实不可变，但一个 skill 从 public 改回 private 后，边缘缓存里的副本仍会继续对外提供服务。5 分钟的上限把这个窗口压到可接受范围，而本项目的流量规模根本不需要长缓存。

### 7.3 Registry 协议

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/.well-known/agent-skills/index.json` | 仅 public skill |
| GET | `/.well-known/skills/index.json` | 同上，别名 |
| GET | `/i/:key/**/.well-known/agent-skills/index.json` | 该 key 对应用户可见的全部 skill |
| GET | `/i/:key/**/.well-known/skills/index.json` | 同上，别名 |

`**` 通配是为了满足 3.5 节描述的单 skill 安装路径行为。index 中的 `url` 一律输出**绝对地址**，私有 index 输出的地址带 `/i/<key>` 前缀。

响应头：`Content-Type: application/json`、`Cache-Control: no-cache`（内容随发布变化，且私有 index 不应被中间层缓存）。

### 7.4 发布 API

```
PUT /api/skills/:slug
Authorization: Bearer <api_token>
Content-Type: application/zip | application/gzip | text/markdown
Body: 原始字节
```

成功返回 `201` + `{ slug, version, digest, files }`；内容与最新版本一致时返回 `200` + `{ unchanged: true }`。

使用示例：

```bash
cd my-skill && zip -r - . | \
  curl -X PUT --data-binary @- \
       -H "Authorization: Bearer $SKILLSGIST_TOKEN" \
       -H "Content-Type: application/zip" \
       https://<域名>/api/skills/my-skill
```

`:slug` 与 frontmatter `name` 不一致时返回 400，不做静默改名。

## 8. 上传规范化流水线

`normalizeUpload(bytes, contentType)` 是唯一入口，网页上传、粘贴文本、编辑保存、`PUT` API 四条路径全部走它。

1. **识别格式** — 魔数优先：`1f 8b` → tar.gz；`50 4b` → zip；否则按 UTF-8 文本的 SKILL.md 处理
2. **解包**
   - tar.gz：`DecompressionStream('gzip')` 原生解压 + 自写 tar 读取器（仅解析 512 字节头，约 40 行）
   - zip：自写中央目录解析 + 方法 8 用 `DecompressionStream('deflate-raw')` 原生解压、方法 0 直接取字节，其他方法报错
   - 纯文本：构造只含一个 `SKILL.md` 的文件表
3. **路径清洗** — 去掉 `./` 前缀；拒绝 `..`、绝对路径、`\`、NUL；丢弃 `__MACOSX/` 与 `.DS_Store`；遇到软/硬链接条目直接报错
4. **剥外层目录** — 若根目录没有 `SKILL.md`，但所有文件共享同一首层目录，剥掉该层。这一步让「GitHub 下载的 zip」和「`tar czf - my-skill/`」都能直接用
5. **校验** — 根必须有 `SKILL.md`；用 `yaml` 包解析 frontmatter，`name` 与 `description` 必填；规则**逐条照抄 3.2 节的 CLI 校验规则**，在上传时就拦下并给出明确原因，而不是等用户安装时静默失败
6. **限额** — 上传 ≤ 2 MB，解包后 ≤ 8 MB，文件数 ≤ 200（CLI 上限是 50 MB / 1000，此处留足余量同时控制 CPU，见第 12 节）
7. **重新打包** — 路径按字典序排序、固定 mtime 为 0、不写目录条目；每个文件用 `CompressionStream('deflate-raw')` 原生压缩后按 zip 方法 8 写入，CRC32 用 JS 查表法计算
8. **计算 digest** — `crypto.subtle.digest('SHA-256')`。若与当前最新版本的 digest 相同，不建新版本，返回「内容无变化」
9. **渲染** — `marked` 渲染 SKILL.md 后用 HTMLRewriter 净化，得到的 HTML 一并入库
10. **落库** — 版本号用 `INSERT ... SELECT COALESCE(MAX(version), 0) + 1 FROM versions WHERE slug = ?` 在库内分配，`PRIMARY KEY (slug, version)` 保证并发发布时后者直接冲突失败而不是悄悄覆盖；R2 `put` 写 `skills/<slug>/<version>.zip`；`skills` 与 `versions` 的写入放进同一个 D1 `batch()` 保证原子性

## 9. Registry index 生成

- 公开 index：`SELECT` 全部 `visibility = 'public'` 的 skill 及其最新版本
- 私有 index：`install_key` 命中用户后，返回全部 skill（public + private）
- 每条输出 `{ name: slug, description, type: "archive", url: <绝对地址>, digest }`
- 输出前用一个 `isValidIndexEntry()` 做自检，不满足 3.2 节规则的条目**不输出**并记录警告 —— 宁可少一条，也不要让 CLI 拿到半个坏 index
- D1 查询失败时返回 503 而非空 `skills` 数组：CLI 对非 200 会跳过并尝试下一个候选地址，而空数组会被当成「这个 registry 是空的」

## 10. 渲染与前端

- **Markdown**：`marked` 渲染 → Cloudflare 原生 `HTMLRewriter` 做白名单净化，移除 `script` / `style` / `iframe` / `object` / `embed`，剥除全部 `on*` 属性，拦截 `javascript:` 与 `data:` 开头的 `href` / `src`
- **模板**：Hono 内置 JSX（`hono/jsx`）服务端渲染，无客户端框架、无 hydration
- **Tailwind**：v4，`@tailwindcss/cli` 把 `src/app.css` 构建到 `public/app.css`，由 Workers Assets 托管
- **交互**：只有表单提交和几个 POST 按钮，原生 HTML form，零 JavaScript
- **代码高亮**：不做（YAGNI），代码块用等宽字体加浅背景即可

## 11. 错误处理

- 无效 `install_key` 访问 `/i/<key>/...` → **404 而非 401**，不泄露 key 是否存在
- 无权访问私有产物 → 404
- 上传校验失败 → 400 + 具体原因（命中了哪一条规则），网页表单原地回显并保留已填内容
- 发布过程中 R2 写成功但 D1 写失败 → 记录孤儿 R2 对象的 key 并返回 500；R2 对象按 `skills/<slug>/<version>.zip` 命名，重试会覆盖同一 key，不产生累积垃圾
- 未捕获异常 → 网页返回渲染过的错误页，API 返回 `{ error, message }` JSON

## 12. 性能与 Cloudflare Free 套餐约束

已确认 Workers Free 的 CPU 上限是**单次请求 10 ms**（Paid 默认 30 s）。设计据此做了三处针对性处理：

1. **所有压缩/解压走原生 `CompressionStream` / `DecompressionStream`**（已确认 Workers 支持 `gzip`、`deflate`、`deflate-raw`），不用 JS 实现的 inflate/deflate
2. **markdown 渲染在发布时完成并存库**，页面访问不做渲染
3. **PBKDF2 迭代数 10,000**（约 3–6 ms），配合 ≥12 位密码强制要求

剩余的 JS 侧 O(n) 工作只有 CRC32 与路径处理，在 2 MB 上传上限内可控。发布是唯一的 CPU 密集路径；若将来发布大 skill 触发 CPU 超限，处置顺序是：先提高套餐到 Paid，再把第 8 节的限额与 PBKDF2 迭代数调上去。

其余免费额度（Workers 10 万请求/天、D1 5 GB、R2 10 GB）对团队内部使用绰绰有余。

## 13. 测试策略

采用 TDD。测试运行在 Vitest + `@cloudflare/vitest-pool-workers`，使用 miniflare 提供的**真实 D1 与 R2**，不 mock 存储层。

**单元测试** — `normalizeUpload` 每条分支各一例：

- 带 `./` 前缀条目的 tar.gz
- 带外层包裹目录的 zip
- 单个 SKILL.md 文本
- 缺少根 `SKILL.md`
- 路径穿越（`../../etc/passwd`）
- tar 软链接条目、zip symlink 属性
- 超文件数、超解包体积、超上传体积
- `name` 不合法（大写、含 `--`、以 `-` 结尾、超 64 字符）
- `description` 缺失与超 1024 字符
- 重复 digest 的重复发布

**集成测试** — 端到端走 Worker 的 fetch：

- 发布后 `index.json` 的每个字段**逐条满足 3.2 节从 CLI 源码提取的校验规则**
- 下载产物后重算 sha256，断言与 index 中的 digest 一致
- 私有 skill 不出现在公开 index、出现在 `/i/<key>` index
- 无效 `install_key` 返回 404
- 单 skill 安装路径 `/i/<key>/.well-known/agent-skills/<name>/.well-known/agent-skills/index.json` 返回正确 index
- 权限矩阵每一格各一例

**契约测试** — `npm run verify:cli`：

起 `wrangler dev`，通过 API 发布一个 fixture skill，然后真实执行
`npx skills add http://localhost:8787/i/<key> -g -y -s <fixture>`，断言文件落到本地 skills 目录且内容一致。

这是「兼容 skills.sh」的唯一可信证明。**不以阅读源码作为兼容性结论的依据。**

## 14. 项目结构与依赖

```
src/
  index.ts              Hono app + 路由装配
  auth.ts               密码哈希、会话 cookie、install_key / api_token 校验、角色判定
  registry.ts           .well-known index 生成 + 产物下载
  publish.ts            网页上传、粘贴、编辑、PUT API 的四条入口
  skills/normalize.ts   格式识别 → 解包 → 清洗 → 校验 → 重打包
  skills/zip.ts         zip 读写
  skills/tar.ts         tar 读取
  skills/frontmatter.ts
  render/markdown.ts    marked + HTMLRewriter 净化
  views/                JSX 页面组件
  db/schema.sql
  db/queries.ts
  app.css
public/app.css          Tailwind 构建产物
test/
  fixtures/
scripts/verify-cli.mjs
wrangler.jsonc
```

运行时依赖：`hono`、`marked`、`yaml`。
开发依赖：`wrangler`、`typescript`、`vitest`、`@cloudflare/vitest-pool-workers`、`tailwindcss`、`@tailwindcss/cli`、`concurrently`。

原计划中的 `fflate` 不再需要 —— 压缩解压全部由原生 `CompressionStream` / `DecompressionStream` 承担，zip 与 tar 的容器格式解析自行实现。

## 15. 部署

```
npm run build      # tailwind 构建 CSS
npm run dev        # concurrently: tailwind --watch + wrangler dev
npm run deploy     # build + wrangler deploy
npm test           # vitest
npm run verify:cli # 真实 npx skills 契约测试
```

绑定：D1（`DB`）、R2（`BUCKET`）、Assets（`ASSETS`）。
Secrets：`SESSION_SECRET`。

**先用 `*.workers.dev` 子域跑起来**；自定义域名待用户确定 Cloudflare zone 后，在 `wrangler.jsonc` 加 `routes` 即可切换，不影响任何代码。

## 16. 假设与待确认

- **假设**：初期部署在 `*.workers.dev`，自定义域名后续再绑。用户尚未指定域名。
- **假设**：团队内所有登录用户都能看到全部私有 skill，不做 per-skill 的成员级授权。
- **假设**：Cloudflare 账号使用 Workers Free 套餐（用户明确选择）。
