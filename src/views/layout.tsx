import { raw } from "hono/html";
import { Form } from "../csrf";
import type { UserRow } from "../db/queries";

export const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function Icon(props: { children?: unknown }) {
  return (
    <svg
      class="cf-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function ChevronDown() {
  return (
    <Icon>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  );
}

function AccountMenu(props: { user: UserRow }) {
  return (
    <details class="cf-menu">
      <summary class="cf-btn cf-btn-outline">
        <span class="cf-menu-name">{props.user.username}</span>
        <ChevronDown />
      </summary>
      <div class="cf-menu-panel">
        <a href="/me" class="cf-menu-item">Account</a>
        {props.user.role === "admin" ? <a href="/admin/users" class="cf-menu-item">Users</a> : null}
        <Form action="/logout">
          <button type="submit" class="cf-menu-item">Sign out</button>
        </Form>
      </div>
    </details>
  );
}

export function Layout(props: {
  title: string;
  user: UserRow | null;
  bare?: boolean;
  hideSignIn?: boolean;
  children?: unknown;
}) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#fdfdfc" />
          <title>{props.title} · skillsgist</title>
          <link rel="preload" href="/fonts/schibsted-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href="/app.css" />
          <script src="/copy.js" defer />
          <script src="/fold.js" defer />
        </head>
        <body class="cf-body">
          <a href="#main" class="cf-skip">Skip to content</a>
          <header class="cf-nav">
            <nav class="cf-nav-inner" aria-label="Main">
              <a href="/" class="cf-wordmark">skillsgist</a>
              <span class="flex-1" />
              {props.user ? (
                <>
                  <a href="/new" class="cf-btn cf-btn-primary">Publish</a>
                  <AccountMenu user={props.user} />
                </>
              ) : props.hideSignIn ? null : (
                <a href="/login" class="cf-btn cf-btn-primary">Sign in</a>
              )}
            </nav>
          </header>
          {props.bare ? (
            <main id="main" class="cf-main">{props.children}</main>
          ) : (
            <main id="main" class="cf-main">
              <div class="cf-page cf-guides cf-page-body">{props.children}</div>
            </main>
          )}
          <footer class="cf-footer">
            <div class="cf-footer-inner">
              <p>
                <a href="/" class="cf-footer-mark">skillsgist</a>
                <span>A private registry for Agent Skills, running on Cloudflare Workers.</span>
              </p>
              <nav class="cf-footer-links" aria-label="Footer">
                <a href="https://github.com/Qsnh/skillsgist">Source on GitHub</a>
              </nav>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}

export function PageHead(props: { title: unknown; aside?: unknown; compact?: boolean; children?: unknown }) {
  return (
    <header class={props.compact ? "cf-head cf-head-compact" : "cf-head"}>
      <div class="cf-head-row">
        <h1 class="cf-head-title">{props.title}</h1>
        {props.aside}
      </div>
      {props.children ? <div class="cf-head-lede">{props.children}</div> : null}
    </header>
  );
}

export function Panel(props: { title?: unknown; aside?: unknown; foot?: unknown; class?: string; children?: unknown }) {
  return (
    <section class={`cf-frame cf-panel ${props.class ?? ""}`}>
      {props.title ? (
        <header class="cf-panel-head">
          <h2 class="cf-panel-title">{props.title}</h2>
          {props.aside}
        </header>
      ) : null}
      <div class="cf-panel-body">{props.children}</div>
      {props.foot}
    </section>
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  value?: string;
  hint?: string;
  autocomplete?: string;
}) {
  return (
    <label class="cf-field">
      <span class="cf-label">{props.label}</span>
      <input
        class="cf-input"
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        autocomplete={props.autocomplete}
        required
      />
      {props.hint ? <span class="cf-hint">{props.hint}</span> : null}
    </label>
  );
}

export function Select(props: { label: string; name: string; children?: unknown }) {
  return (
    <label class="cf-field">
      <span class="cf-label">{props.label}</span>
      <span class="cf-select">
        <select name={props.name} class="cf-input">{props.children}</select>
        <ChevronDown />
      </span>
    </label>
  );
}

export function Button(props: {
  variant?: "primary" | "outline" | "danger";
  size?: "sm";
  wide?: boolean;
  children?: unknown;
}) {
  const variant = props.variant ?? "primary";
  const classes = ["cf-btn", `cf-btn-${variant}`, props.size ? "cf-btn-sm" : "", props.wide ? "cf-btn-wide" : ""];
  return (
    <button type="submit" class={classes.filter(Boolean).join(" ")}>
      {props.children}
    </button>
  );
}

export function Alert(props: { message?: string }) {
  if (!props.message) return null;
  return (
    <p class="cf-alert" role="alert">
      <Icon>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 11h.01" />
      </Icon>
      <span>{props.message}</span>
    </p>
  );
}

export function CodeBlock(props: { prompt?: boolean; raised?: boolean; children?: unknown }) {
  return (
    <div class={props.raised ? "cf-command" : "cf-command cf-command-flat"} data-copy>
      {props.prompt === false ? null : <span class="cf-command-prompt" aria-hidden="true">$</span>}
      <code class="cf-command-text">{props.children}</code>
      <button type="button" class="cf-command-copy" hidden>
        <Icon>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </Icon>
        <span class="cf-command-copy-label">Copy</span>
      </button>
      <span class="cf-command-status sr-only" role="status" />
    </div>
  );
}
