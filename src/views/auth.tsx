import { Form } from "../csrf";
import { Alert, Button, CodeBlock, Field, Layout } from "./layout";
import type { UserRow } from "../db/queries";

export function SetupPage(props: { error?: string }) {
  return (
    <Layout title="初始化" user={null}>
      <h1 class="mb-4 text-xl font-semibold">创建管理员</h1>
      <Alert message={props.error} />
      {/* Plain <form>, not <Form>: no session exists during bootstrap, so
          there is no session-bound token to render. Covered by the Origin /
          Sec-Fetch-Site layer only — see TOKENLESS_PATHS in src/csrf.tsx. */}
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
      <Alert message={props.error} />
      {/* Plain <form>, not <Form>: same reason as SetupPage above — no session
          to bind a token to yet. See TOKENLESS_PATHS in src/csrf.tsx. */}
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
      <Alert message={props.error} />

      <section class="mb-8">
        <h2 class="mb-2 font-medium">安装全部 skill</h2>
        <CodeBlock>npx skills add {installUrl}</CodeBlock>
        <p class="mt-2 text-xs text-slate-500">
          这串 key 只有安装权限，不能登录、发布或删除。怀疑泄漏时点下面的按钮重置。
        </p>
        <Form action="/me/install-key" class="mt-2">
          <Button>重置 install key</Button>
        </Form>
      </section>

      <section class="mb-8">
        <h2 class="mb-2 font-medium">API token（用于 curl 发布）</h2>
        {props.newToken ? (
          <CodeBlock>{props.newToken}</CodeBlock>
        ) : null}
        {props.newToken ? (
          <p class="mt-2 text-xs text-amber-700">这串 token 只显示这一次，请立刻保存。</p>
        ) : (
          <p class="mt-2 text-xs text-slate-500">
            当前状态：{props.user.api_token_hash ? "已启用" : "未生成"}
          </p>
        )}
        <div class="mt-2 flex gap-2">
          <Form action="/me/api-token"><Button>生成新 token</Button></Form>
          {props.user.api_token_hash ? (
            <Form action="/me/api-token/revoke"><Button>吊销</Button></Form>
          ) : null}
        </div>
      </section>

      <section>
        <h2 class="mb-2 font-medium">修改密码</h2>
        <Form action="/me/password" class="max-w-sm space-y-4">
          <Field label="当前密码" name="current" type="password" />
          <Field label="新密码" name="next" type="password" hint="至少 12 个字符" />
          <Button>保存</Button>
        </Form>
      </section>
    </Layout>
  );
}

export function UsersPage(props: { user: UserRow; users: UserRow[]; error?: string }) {
  return (
    <Layout title="用户管理" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">用户管理</h1>
      <Alert message={props.error} />
      <table class="mb-8 w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-slate-500">
            <th class="py-2">用户名</th><th>角色</th><th>最近登录</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {props.users.map((u) => {
            // Regression 1 (scoped re-review of the final fix wave): the
            // server refuses self-targeted role changes and deletes
            // outright (see routes/users.tsx), but a UI that still renders
            // a control the server will always reject is a bad guard —
            // hide the role-toggle and delete controls on the viewer's own
            // row instead of letting them click into a guaranteed 400.
            const isSelf = u.id === props.user.id;
            return (
              <tr class="border-b border-slate-100 align-top">
                <td class="py-2">{u.username}</td>
                <td>{u.role}</td>
                <td>{u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 10) : "—"}</td>
                <td class="space-y-2 py-2">
                  {isSelf ? null : (
                    <>
                      <Form action={`/admin/users/${u.id}/role`} class="inline-block">
                        <input type="hidden" name="role" value={u.role === "admin" ? "member" : "admin"} />
                        <Button>{u.role === "admin" ? "降为 member" : "升为 admin"}</Button>
                      </Form>{" "}
                    </>
                  )}
                  <Form action={`/admin/users/${u.id}/install-key`} class="inline-block">
                    <Button>轮换 install key</Button>
                  </Form>{" "}
                  {u.api_token_hash ? (
                    <Form action={`/admin/users/${u.id}/api-token/revoke`} class="inline-block">
                      <Button>吊销 api token</Button>
                    </Form>
                  ) : null}
                  <Form action={`/admin/users/${u.id}/password`} class="mt-1 flex items-center gap-2">
                    <input
                      type="password"
                      name="password"
                      placeholder="新密码（至少 12 位）"
                      class="rounded border border-slate-300 px-2 py-1 text-sm"
                      required
                    />
                    <Button>重置密码</Button>
                  </Form>
                  {isSelf ? null : (
                    <div class="mt-1">
                      <Form action={`/admin/users/${u.id}/delete`} class="inline-block">
                        <Button>删除账号</Button>
                      </Form>
                      <p class="mt-1 max-w-xs text-xs text-slate-500">
                        删除会把这个用户拥有的 skill 与已发布版本的作者记录转给你。想保留作者记录的话，改用「降为
                        member」加「轮换 install key」，不要删除。
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2 class="mb-2 font-medium">新增用户</h2>
      <Form action="/admin/users" class="max-w-sm space-y-4">
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
      </Form>
    </Layout>
  );
}
