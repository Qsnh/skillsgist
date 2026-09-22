# CSRF 防护修复计划（v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给全部「用会话 cookie 鉴权的变更路由」加上与会话绑定的 CSRF token，并把校验放在**默认开启的中间件**里，让「新加一条路由忘了加防护」这个失效模式本身消失。

**v2 相对 v1 的变化：** 三处实测发现让实现显著变小——① Hono 4.13.8 自带 `hono/csrf`，它做的正好是计划里的 Origin 层，还额外带了 `Sec-Fetch-Site` 校验；② `hono/jsx` 的 context 在 SSR 下可用（已在 workerd 里实测），因此 18 个调用点 × prop 透传 → 0；③ 顺带查出一个既有 bug：`app.onError` 会把 `HTTPException` 吞成 500。

**Spec 影响:** `docs/superpowers/specs/2026-09-21-skillsgist-design.md` §会话（第 123 行）需补一句会话载荷多了 `csrf` 字段。「不建 sessions 表」的约束在本方案下依然成立。

---

## 1. 现状与风险校准

先把话说准，避免按错误的威胁模型设计：

**`SameSite=Lax` 确实拦得住经典的跨站 form POST。** 当前所有变更路由都是 POST/PUT（已逐条核对，无「变更型 GET」），Lax 在跨站 POST 上不会附带 cookie。所以这**不是**一个可以立刻打穿的洞。顺带澄清一条常被引用的说法：Chrome 那个「新建 2 分钟内 cookie 允许跨站 POST」的兼容宽限（Lax+POST intervention）只作用于**没有显式写 SameSite 属性**的 cookie；`src/auth.ts:86` 是显式写了 `sameSite: "Lax"` 的，不在该宽限范围内。

**但把整个防线押在一个 cookie 属性上，有三个真实的残余缺口：**

1. **same-site ≠ same-origin（最强的一条）。** Lax 的作用域是可注册域（eTLD+1），不是 origin。部署在 `skills.example.com` 的话，`*.example.com` 下**任何**别的应用——HTML 注入、用户内容托管、或一个被接管的子域——都算 same-site，它发出的 POST 会带上完整会话 cookie。子域接管是很常见的一类事故。
2. **老客户端与嵌入式 WebView 直接忽略 SameSite 属性。** 忽略了等于没写。
3. **没有任何结构性的东西在守「不许出现变更型 GET」这条不变量。** 今天成立纯属代码碰巧都用了 POST。哪天有人为了方便加一个 `GET /s/:slug/delete`，Lax 对顶层 GET 导航是**放行**的，这条路由静默可打，且没有任何测试会红。

**这次新增的管理员路由把「影响」从烦人抬到了接管。** 按危害排序：

| 路由 | 一旦被 CSRF 打中 |
|---|---|
| `POST /admin/users/:id/password` | **任意账号接管**——重置他人密码不需要原密码 |
| `POST /admin/users` (`role=admin`) | 种一个长期后门管理员 |
| `POST /admin/users/:id/role` | 提权 member → admin |
| `POST /admin/users/:id/delete` | 破坏性删号，且会把受害者的 skill 所有权转走 |
| `POST /s/:slug/delete` | 删 skill，连带删 R2 对象，不可恢复 |
| `POST /s/:slug/visibility` | **私有 skill 翻成 public** → 数据泄露（翻完攻击者可匿名读） |
| `POST /me/install-key`、`/me/api-token(/revoke)`、`/admin/users/:id/{install-key,api-token/revoke}` | 凭据失效（DoS）；新 token 只出现在响应体里，跨源读不到，不构成窃取 |
| `POST /me/password` | 需要原密码，基本无害 |
| `POST /logout` | 骚扰 |
| `POST /login` | 登录 CSRF（把受害者塞进攻击者的会话） |

结论：Lax 保留，但它从此只是纵深防御的**外层**，不再是唯一一层。

---

## 2. 方案

三层，全部默认生效。

### 2.1 前置：修掉 `app.onError` 吞掉 `HTTPException` 的既有 bug

**这一步必须先做，否则下面的 403 会变成 500。**

Hono 的**默认** error handler 会特判 `HTTPException` 并返回它自带的响应（`node_modules/hono/dist/hono-base.js:10-12`：`if ("getResponse" in err)`）。但 `app.onError(...)` 是**替换**掉这个默认 handler（同文件 `:163`），而 `src/index.ts:42` 正是这么做的。于是今天 Hono 内部任何地方抛出的 `HTTPException` 都会被当成未知错误，打一条 `console.error("unhandled", ...)` 然后返回 500「服务内部错误」。

已实测确认：接入 `hono/csrf` 后，它抛的 403 在有 `onError` 的 app 上变成 500 + 「服务内部错误」。

这是个独立于 CSRF 的 bug，值得单独修。

### 2.2 第一层：直接用 `hono/csrf`（不再手写 Origin 校验）

Hono 4.13.8 自带 `hono/csrf`（`node_modules/hono/dist/middleware/csrf/index.js`），读过源码并实测了 6 条行为：

| 场景 | 结果 | 说明 |
|---|---|---|
| form POST，既无 `Origin` 也无 `Sec-Fetch-Site` | **403** | fail-closed |
| `Origin` 同源 | 放行 | |
| 只有 `Sec-Fetch-Site: same-origin`，无 `Origin` | 放行 | |
| `Sec-Fetch-Site: same-site` | **403** | **这正是 §1 缺口 1 的子域场景，被关掉了** |
| `Content-Type: application/zip` 的 `PUT` | 直接放行、body 不被触碰 | `PUT /api/skills/:slug` **不需要任何路径豁免** |
| 无 `Content-Type` 的 POST | 按 `text/plain` 处理，照常校验 | fail-closed |

它比我 v1 手写的版本多了 `Sec-Fetch-Site` 这一层。`Sec-` 前缀属于 forbidden header name，页面 JS 无法设置，所以这个头不可伪造；而且它区分 same-origin / same-site，比 `Origin` 更细。它只在头**存在**时才据此判定，不存在就回落到 `Origin` 判定，所以不依赖浏览器版本（Safari 支持较晚这件事不影响设计）。

它比 v1 少了 `Referer` 回退。这没问题：`Referer` 会被 referrer policy 抑制，本来就是更不可靠的信号，去掉更简单。

它只对「表单可提交的 content-type」（`x-www-form-urlencoded` / `multipart/form-data` / `text/plain`）生效。这是标准判据：跨站表单只能发这三种；换成别的 content-type 就需要 CORS 预检，而本项目没有任何 CORS 头，预检必败。

> 部署注意：默认 origin 判定是 `origin === new URL(c.req.url).origin`。本项目直接跑在 Cloudflare Workers 上，`c.req.url` 就是面向客户端的真实 URL，所以成立。若将来在前面套一层会改写 scheme/Host 的代理，需要传 `options.origin`。写进代码注释。

### 2.3 第二层：与会话绑定的 CSRF token（任务要求的那个 token）

**token 存在已有的签名会话 cookie 里，不新增 cookie、不新增表、不新增密钥。** 会话载荷 `{ uid, exp }` → `{ uid, exp, csrf }`，`csrf` 是 `randomHex(16)`。表单渲染成 `<input type="hidden" name="_csrf">`，POST 时从 body 取出，与会话里的值做常量时间比较。

**为什么不用常见的 double-submit cookie（token 同时放在独立 cookie 和表单里，服务端比两者是否相等）：** 那个模式恰好死在 §1 缺口 1 上。控制了 `evil.example.com` 的攻击者可以给 `.example.com` 写一个值由他自己选的 `sg_csrf` cookie，伪造表单里填同一个值，校验直接通过。给 cookie 签名也救不了——签名只保证「值是服务器发的」，不保证「值属于受害者的会话」。

绑进现有签名会话就没这问题：要通过校验得伪造一个携带指定 `csrf` 的**合法签名会话**，那需要 `SESSION_SECRET`；而注入你自己那份真实会话只会让请求以**你的**账号在跑，伤不到受害者。

顺带好处：token 随会话自然轮换，30 天 TTL 到期一起失效，`HttpOnly` 让它不可被脚本从 cookie 读出（只在 HTML 里出现一次）。

### 2.4 强制点：中间件，不是逐路由

整个计划最关键的一条。两层都注册成 `app.use("*", ...)`，放在 `app.route(...)` **之前**，默认对所有非安全方法生效，豁免走一份短小、显式、有测试兜底的名单。逐路由 opt-in 正是当初漏掉全站的原因。

**豁免清单（仅第二层需要；第一层靠 content-type 天然放行 `/api/*`）：**

| 豁免 | 理由 | 兜底 |
|---|---|---|
| `GET` / `HEAD` / `OPTIONS` | 按定义不变更状态 | 任务 3 的路由枚举测试断言不存在变更型 GET |
| `/api/*` 前缀 | 只认 `Authorization: Bearer`（`src/routes/publish.tsx:93` 调 `userFromApiToken`，压根不读 cookie）。浏览器不会自动附带 Authorization 头 → 结构上不可被 CSRF。README 的 curl 发布契约必须保住。 | **专门一条测试**断言「只带会话 cookie、不带 Bearer 无法通过 `/api/*` 鉴权」——这条测试才是按路径豁免成立的依据 |
| `POST /setup`、`POST /login` | 此时还没有会话，拿不到会话绑定的 token（第一层照常拦） | 见下方「已知取舍」 |

这里**刻意没有**把第二层的判据也改成「按 content-type」去镜像第一层。那样 `/api/*` 的豁免理由会变成隐式的（「它的 content-type 不是表单类型」），将来有人加一个 **cookie 鉴权的 JSON 接口**就会静默失去保护。显式的路径豁免 + 一条不变量测试更清楚。

**已知取舍（明确写下来，不是疏忽）：** `/login` 和 `/setup` 只有第一层保护，没有 token。登录 CSRF 在此场景危害有限（攻击者得先有有效凭据，收益是诱使受害者往攻击者账号里发布东西），而为它单独引入「未登录态 pre-session cookie」会把复杂度抬一截。升级路径：在 `GET /login` 下发一次性 `csrf` cookie，在 `POST /login` 比对。

### 2.5 token 怎么进到表单里：jsx context + `<Form>` + `page()` 助手

**这是 v2 相对 v1 最大的简化。v1 要给 8 个视图组件加 prop、约 18 个 `c.html` 调用点各加一处 `csrf={...}`；v2 的 prop 透传是 0。**

三个小东西：

```tsx
// src/render.tsx
const CsrfContext = createContext<string>("");

export function CsrfField() {
  const token = useContext(CsrfContext);
  // 没走 page() 就渲染 → 这里直接抛，GET 阶段就 500（被 app.onError 接住），
  // 而不是等到 POST 时收一个莫名的 403。
  if (!token) throw new Error("CsrfField rendered outside page() — no csrf token in context");
  return <input type="hidden" name="_csrf" value={token} />;
}

export function page(c: Ctx, element: JSX.Element, status?: ContentfulStatusCode) {
  const token = /* 本请求的会话 csrf */;
  return c.html(<CsrfContext.Provider value={token}>{element}</CsrfContext.Provider>, status);
}
```

```tsx
// src/views/layout.tsx —— 全站唯一知道 token 存在的地方
export function Form(props: { action: string; class?: string; children?: unknown }) {
  return (
    <form method="post" action={props.action} class={props.class}>
      <CsrfField />
      {props.children}
    </form>
  );
}
```

**已在真实 workerd 运行时实测（4 条 spike 测试全绿，随后删除）：**

- context 能穿透到嵌套 3 层深的同步组件（`Layout` → `div` → `div` → `Form` → `CsrfField`）
- **跨 `await` 边界也保得住**——`wrangler.jsonc` 已开 `nodejs_compat`，所以 `AsyncLocalStorage` 可用，`hono/jsx` 会用它做 per-render 隔离（`dist/jsx/context.js`）。没有 ALS 时 hono 会退化到默认值并只 warn 一次，那是个真正的坑，但本项目不踩
- **3 个并发请求之间不串值**（sync 渲染是 push→render→pop，且有 ALS 兜底）
- 没有 Provider 时回落到 context 默认值 —— 所以上面那个 `throw` 是必要的，让它响亮地失败

改动量：
- 15 个 `<form method="post">` → `<Form>`（`<form method="get">` 的搜索表单**不动**，加了 token 会泄进 URL 和 Referer）
- 约 18 个 `c.html(<X/>, 400)` → `page(c, <X/>, 400)`：**纯重命名，status 参数原样保留**
- 视图组件 prop：**0 处改动**

**考虑过但否掉的三个替代（理由记在这里，免得后人重新推一遍）：**

1. **HTMLRewriter 响应中间件自动注入隐藏字段。** 「忘了加」在构造上不可能，且 `form` 确实不在 sanitizer 的 `ALLOWED_TAGS` 里（`src/render/markdown.ts:12`，注释里是刻意排除的），没有注进用户可控表单的风险。**但否掉：** 本仓库 Global Constraints 明确写了「单次请求 10 ms」和「markdown 只在发布时渲染并存库」，即刻意不在请求时做能提前做的 HTML 处理；给每个 HTML 响应（含渲染后可能很大的详情页）加一次请求时流式解析，方向相悖。
2. **`hono/jsx-renderer` + `useRequestContext()`。** 更 idiomatic，且 `useRequestContext()` 本身就会在误用时抛。**但否掉：** `c.render()` **不接受 status 参数**（已读源码确认：`createRenderer` 里是裸的 `c.html(body)`），于是 13 处非 200 的错误分支都得拆成 `c.status(400); return c.render(...)` 两句；还要给 5 处 `new Hono<...>()` 补 `Variables` 类型。净churn 比 `page()` 大。
3. **在中间件里 monkey-patch `c.html`。** 调用点改动为 **0**，是可能的最小 diff。**但否掉：** 前后一致——既然因为「隐式」否掉了 HTMLRewriter，就不该转头去悄悄改掉一个框架核心 API 的语义，那更让人意外，而且 Hono 小版本升级容易崩。

### 2.6 「忘了加」这件事怎么被兜住

三道，各管一类：

| 失效方式 | 兜住它的东西 |
|---|---|
| 某个路由没走 `page()` | `CsrfField` 抛异常 → 该页面 GET 变 500 → **现有测试就会红，不用新写测试** |
| 有人手写了裸 `<form method="post">` 而不是 `<Form>` | 页面遍历测试（任务 7）：渲染每个页面，抓出所有 `method="post"` 的表单，断言都含 `_csrf` |
| 新增了一条变更路由 | 路由枚举测试（任务 3）：遍历 `app.routes`，断言每条非 GET 路由要么在豁免名单要么在受保护名单 |

> 为什么不用「静态 grep 源码」的测试：测试跑在 workerd 里，`node:fs` 是个沙箱化的空虚拟文件系统，读不到宿主磁盘（`vitest.config.ts` 顶部注释已实证记录）。所以遍历页面的运行时测试是对的做法——而且它断言的是真实输出而非源码文本，本来就更有价值。

---

## 3. 任务拆解

按 TDD 顺序：每个任务先写失败的测试，再写实现。

### 任务 1：修 `app.onError` 吞 `HTTPException`（前置，独立 bug）
- [x] 测试：一条会抛 `HTTPException(403)` 的路由，返回 403 而不是 500
- [x] 实现：`src/index.ts` 的 `onError` 开头加 `if (err instanceof HTTPException) return err.getResponse();`
- [x] 注释说明：`app.onError` 替换掉了 Hono 特判 `HTTPException` 的默认 handler（`hono-base.js:10-12` vs `:163`），所以必须自己特判

### 任务 2：会话载荷带上 csrf（`src/auth.ts`）
- [x] 测试：`startSession` 后，用 `SESSION_SECRET` 解出的载荷含 `csrf`，形如 `^[a-f0-9]{32}$`
- [x] 测试：两次 `startSession` 产生不同的 `csrf`
- [x] 测试：载荷里没有 `csrf` 的旧会话，`currentUser` 返回 `null`
- [x] 实现：`startSession` 生成 `randomHex(16)` 写入载荷
- [x] 实现：新增 `sessionCsrf(c): Promise<string | null>`
- [x] 实现：`currentUser` 在 `typeof payload.csrf !== "string"` 时返回 `null`
- [x] 实现：导出 `constantTimeEqual`（目前模块私有，`src/auth.ts:39`）与 `CSRF_FIELD = "_csrf"`
- [x] 注释：让旧会话失效 = 线上所有人被强制重登一次。这是刻意接受的一次性代价；替代方案（放行无 `csrf` 的会话）等于给攻击者留一个「降级到无防护」的开关

### 任务 3：路由枚举守卫测试（先写，它定义验收标准）
- [x] 测试：遍历 `app.routes`（Hono 4.13.8 公开此属性，已实测：`route()` 挂载的子应用会摊平进来，中间件以 `{method:"ALL", path:"/*"}` 出现），过滤掉 `GET`/`HEAD`/`OPTIONS` 与 `path === "/*"`，断言剩下每条要么在显式豁免名单要么在受保护名单。**名单从路由器实测得出，不是手维护的**，新增变更路由而没做决策就会红
- [x] 测试：断言不存在任何变更语义的 GET 路由（守住 §1 缺口 3）

### 任务 4：接入 `hono/csrf`（第一层）
- [x] 测试：form POST 无 `Origin` 无 `Sec-Fetch-Site` → 403
- [x] 测试：`Origin` 同源 → 放行
- [x] 测试：`Sec-Fetch-Site: same-site` → 403（子域场景）
- [x] 测试：`PUT /api/skills/:slug` 带 Bearer + `Content-Type: application/zip`、无 Origin → 照常 201
- [x] 实现：`src/index.ts` 里 `app.use("*", csrf())`，注册在 `app.route(...)` 之前
- [x] 注释：记下它同时覆盖 `Sec-Fetch-Site` 与 `Origin`、为什么非表单 content-type 放行是安全的（跨站表单只能发那 3 种；换别的要 CORS 预检，本项目无 CORS 头必败）、以及套代理时要传 `options.origin`

### 任务 5：token 校验中间件（新文件 `src/csrf.ts`）
- [x] 测试：`_csrf` 缺失 / 为空 / 错误 / 是别人会话的 token → 403
- [x] 测试：`_csrf` 正确 → 放行
- [x] 测试：`Content-Type: text/plain` 的 POST → `parseBody` 返回 `{}`，无 token → 403（确认 fail-closed）
- [x] 测试：**只带会话 cookie、不带 Bearer 访问 `/api/skills/:slug` → 404**（§2.4 按路径豁免的依据）
- [x] 实现：安全方法直接 `next()`；`/api/*`、`/setup`、`/login` 跳过（带注释指回 §2.4）
- [x] 实现：其余从 `await c.req.parseBody()` 取 `_csrf`，与 `sessionCsrf(c)` 做 `constantTimeEqual`；无会话时不在这里 403（交给路由自己 `redirect("/login")`，保持现有行为）
- [x] 实现：失败返回 `c.text("请求校验失败，请刷新页面后重试", 403)`，与现有 `c.text(..., 403)` 风格一致
- [x] 注释里记下已验证的事实：中间件调 `parseBody()` **不会**吃掉路由自己的 `parseBody()`。Hono 4.13.8 的 `parseBody` 内部走 `request.arrayBuffer()`（经 `#cachedBody` 缓存）并把结果写进 `request.bodyCache.formData`，第二次调用命中缓存（`dist/utils/body.js:16-32`、`dist/request.js:86-104`）。非表单 content-type 则直接返回 `{}`，连 body 都不读

### 任务 6：`page()` + `<Form>` + `CsrfField`
- [x] 测试：context 穿透到嵌套多层的组件（把 spike 的断言收进正式测试）
- [x] 测试：并发渲染不串 token
- [x] 测试：不走 `page()` 渲染含 `<Form>` 的页面 → 抛错（被 `onError` 变成 500）
- [x] 实现：`src/render.tsx` 的 `CsrfContext` / `CsrfField` / `page(c, element, status?)`
- [x] 实现：`src/views/layout.tsx` 的 `Form` 组件
- [x] 改造：15 个 `<form method="post">` → `<Form>`（`layout.tsx` 退出登录 1、`auth.tsx` MePage 4 + UsersPage 6、`publish.tsx` 2、`skills.tsx` 2）。**`skills.tsx` 的 `method="get"` 搜索表单不要动**
- [x] 改造：`src/routes/{users,publish,skills}.tsx` 约 18 个 `c.html(...)` → `page(c, ...)`。注意包含各错误分支（`users.tsx:142` 的 `fail` 闭包、`185`、`193`、`209`、`248`、`254`；`publish.tsx:50`、`53`、`86`），漏掉会导致「提交失败 → 错误页 → 再提交又失败」
- [x] `SetupPage` / `LoginPage` 的表单**保持裸 `<form>`**（第二层豁免），并在旁边留一行注释指向 §2.4

### 任务 7：表单遍历守卫测试
- [x] 测试：渲染每个页面（`/`、`/s/:slug`、`/me`、`/admin/users`、`/new`、`/s/:slug/edit`），抓出所有 `<form ... method="post"`，断言每个都含 `name="_csrf"`
- [x] 测试：`/login`、`/setup` 的表单**不含** token（把豁免固化成断言，而不是让它看起来像 bug）
- [x] 测试：`/` 的搜索表单是 `method="get"` 且不含 token

### 任务 8：更新测试脚手架
- [x] `test/helpers.ts`：`login()` 加 `Origin: http://localhost`；改为返回 `{ cookie, csrf }`，csrf 从 `GET /me` 的 HTML 抓隐藏字段（顺带证明表单真渲染了 token）
- [x] `test/users.test.ts`：`form()` / `postAs()` 两个集中点加 Origin 和 `_csrf`
- [x] `test/skills.test.ts`、`test/publish.test.ts`：cookie 鉴权的 POST（`/new` 等）加 Origin 和 `_csrf`。`PUT /api/skills/:slug` 那 20+ 处**不用动**
- [x] `test/registry.test.ts`：核对那 1 处 POST
- [x] `scripts/verify-cli.mjs`：`POST /setup`（95 行）、`POST /login`（105 行）、`POST /me/api-token`（117 行）加 `Origin: ORIGIN`；后者还要加 `_csrf`（需先从 `/me` 抓）。**Node 的 fetch 不发 Origin，漏了这步 CI 会挂**。`PUT /api/skills/:slug`（130、145 行）不用动

### 任务 9：收尾
- [x] `npm run test`、`npm run typecheck` 全绿
- [x] `npm run verify:cli` 通过（真实 `npx skills` 契约未被破坏）
- [x] spec §会话 补一句 `csrf` 字段
- [x] README：确认 curl 发布那段无需改动（`/api/*` 豁免）

---

## 4. 外部契约影响

| 契约 | 影响 |
|---|---|
| README 的 `curl -X PUT ... -H "Authorization: Bearer ..."` 发布 | **无**（content-type 非表单类型 → 第一层放行；`/api/*` → 第二层豁免） |
| `npx skills add <origin>/i/<key>` | **无**（全是 GET） |
| `.well-known/agent-skills/index.json` | **无**（GET） |
| 浏览器端所有表单操作 | 行为不变；线上已登录用户被强制重登一次（任务 2） |

---

## 5. 非目标（本次不做）

- 改密码后轮换会话 / token（好卫生，但与 CSRF 正交）
- 给 `/login`、`/setup` 上 pre-session token（取舍见 §2.4，升级路径已记）
- 会话表、token 单次使用、token 过期独立于会话
- 把 `SameSite` 收紧到 `Strict`（会破坏从外部链接点进来时的登录态，体验代价大于收益）
- **`__Host-sg_session` cookie 前缀。** 它能关掉 cookie **注入**（正是干死 double-submit 的那个缺口），但**关不掉子域 CSRF**——host-only cookie 在同站跨源 POST 时照样会被发送。而且 `__Host-` 强制要求 `Secure`，会弄坏 http 下的 `wrangler dev`。留作独立的低优先级 follow-up
- **无状态 `HMAC(SESSION_SECRET, uid)` 作为 token。** 好处是不用强制重登、无迁移；坏处是**永不轮换**（同一个 uid 永远同一个 token，跨登出和改密码都不变），泄漏一次就得轮换整个 secret 才能收回。既然会话载荷本就是我们可控的签名 blob，往里塞个 nonce 严格更优
- **把会话读取 memoize 到 `c` 上（`Variables`）。** 能省掉每请求一次 HMAC——但那是微秒级，收益纯粹是结构上的；单为此改 5 处类型标注不值得

---

## 6. 两个诚实的残余项

**残余风险：** skill 详情页是唯一一处「CSRF token 和用户可控的已渲染 HTML 同时出现在一页上」的地方（管理者视角会渲染 visibility / delete 表单）。若 sanitizer 出现 XSS 绕过，脚本可以读出 token。缓解是既有的：`form` 不在标签白名单内、CSP `script-src 'self'` 且全站不发任何脚本。任何基于 token 的方案都有这个性质，不构成改变设计的理由——记在这里是为了它被记录过。

**顺手查出的无关 bug：** 当前页面**不输出 `<!DOCTYPE html>`**（实测 `/login` 的响应以 `<html lang="zh-CN">` 开头），浏览器会进 **quirks mode**，影响盒模型等 CSS 行为。`Layout` 里补一个 doctype 即可，一行。不打包进本次改动，单独一个 commit。
