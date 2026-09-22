import { Form } from "../csrf";
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
                <Form action="/logout">
                  <button type="submit" class="text-sm text-slate-600 hover:text-slate-900">退出</button>
                </Form>
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
