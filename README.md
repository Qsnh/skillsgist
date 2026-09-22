# skillsgist

跑在 Cloudflare 上的极简私有 Agent Skills registry。网页管理，`npx skills` 一键安装。

## 它做什么

- 网页上传 / 粘贴 / 编辑 skill，支持 `.zip`、`.tar.gz` 与单个 `SKILL.md`
- 默认私有，单个 skill 可以按需公开
- 兼容 [skills.sh](https://skills.sh) 生态的发现协议，不需要自研 CLI —— 已经用真实的
  `npx skills add` 跑通过（见 `npm run verify:cli`）

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

`wrangler dev` 本身不知道 `SESSION_SECRET`（这个值只在部署时以 secret 形式设置），
所以第一次跑本地开发前，先给自己造一份本地专用的会话密钥，写进 `wrangler dev` 会
自动读取、且已被 `.gitignore` 排除的 `.dev.vars`：

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .dev.vars

npx wrangler d1 migrations apply skillsgist --local
npm run dev          # tailwind --watch + wrangler dev
npm test             # 单元与集成测试
npm run verify:cli   # 用真实的 npx skills 跑一遍契约测试
npm run typecheck
```

`npm run verify:cli` 自己起的那个 `wrangler dev` 不依赖 `.dev.vars`——它会给自己生成
一个临时会话密钥并通过 `--var` 注入，所以在没有 `.dev.vars` 的干净检出上也能直接跑。

## 两个需要知道的约束

**install key 会出现在 URL 里。** `npx skills` 发请求时不带任何自定义 header，所以私有安装的凭据只能编码在路径中。这串 key 只有安装权限 —— 拿到它的人不能登录、不能发布、不能删除 —— 并且可以在 `/me` 页面一键重置。

**上传限额是 2 MB / 解包 8 MB / 200 个文件。** 这是为了适配 Workers Free 套餐单次请求 10 ms 的 CPU 上限。升级到 Workers Paid 之后，可以调高 `src/skills/normalize.ts` 里的三个常量和 `src/auth.ts` 里的 `PBKDF2_ITERATIONS`。

## 设计文档

- 设计：`docs/superpowers/specs/2026-09-21-skillsgist-design.md`
- 实现计划：`docs/superpowers/plans/2026-09-21-skillsgist.md`
