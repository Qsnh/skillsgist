import { raw } from "hono/html";
import { useContext } from "hono/jsx";
import { Form, OptionalCsrfField, OriginContext, ReturnPathContext } from "../csrf";
import type { UserRow } from "../db/queries";
import { FlashContext } from "../flash";
import { useLocale, useT } from "../i18n";
import { LOCALE_NAMES, LOCALES } from "../i18n/locales";

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

export function GlobeIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2z" />
    </Icon>
  );
}

function CheckIcon() {
  return (
    <Icon>
      <path d="M3.5 8.5l3 3 6-7" />
    </Icon>
  );
}

function AccountMenu(props: { user: UserRow }) {
  const t = useT();
  return (
    <details class="cf-menu">
      <summary class="cf-btn cf-btn-outline">
        <span class="cf-menu-name">{props.user.username}</span>
        <ChevronDown />
      </summary>
      <div class="cf-menu-panel">
        <a href="/me" class="cf-menu-item">{t.layout.account}</a>
        <a href="/projects" class="cf-menu-item">{t.layout.projects}</a>
        {props.user.role === "admin" ? <a href="/admin/users" class="cf-menu-item">{t.layout.users}</a> : null}
        <Form action="/logout">
          <button type="submit" class="cf-menu-item">{t.layout.signOut}</button>
        </Form>
      </div>
    </details>
  );
}

function LanguageForm() {
  const locale = useLocale();
  const t = useT();
  const next = useContext(ReturnPathContext);
  return (
    <form method="post" action="/lang">
      <OptionalCsrfField />
      <input type="hidden" name="next" value={next} />
      <details class="cf-menu cf-lang-menu">
        <summary class="cf-btn cf-btn-outline cf-btn-sm">
          <GlobeIcon />
          <span class="sr-only">{t.layout.language}</span>
          <span lang={locale}>{LOCALE_NAMES[locale]}</span>
          <ChevronDown />
        </summary>
        <div class="cf-menu-panel">
          {LOCALES.map((option) =>
            option === locale ? (
              <span class="cf-menu-item cf-lang-option" aria-current="true" lang={option}>
                {LOCALE_NAMES[option]}
                <CheckIcon />
              </span>
            ) : (
              <button type="submit" name="lang" value={option} class="cf-menu-item cf-lang-option" lang={option}>
                {LOCALE_NAMES[option]}
              </button>
            ),
          )}
        </div>
      </details>
    </form>
  );
}

export function Layout(props: {
  title: string;
  user: UserRow | null;
  bare?: boolean;
  hideSignIn?: boolean;
  children?: unknown;
}) {
  const origin = useContext(OriginContext);
  const locale = useLocale();
  const t = useT();
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang={locale}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#fdfdfc" />
          <title>{props.title} · skillsgist</title>
          <link rel="icon" type="image/png" href="/favicon.png" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <meta name="description" content={t.layout.tagline} />
          <meta property="og:site_name" content="skillsgist" />
          <meta property="og:type" content="website" />
          <meta property="og:title" content={`${props.title} · skillsgist`} />
          <meta property="og:description" content={t.layout.tagline} />
          <meta property="og:image" content={`${origin}/og.png`} />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content={t.layout.ogImageAlt} />
          <meta name="twitter:card" content="summary_large_image" />
          <link rel="preload" href="/fonts/schibsted-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href="/app.css" />
          <script src="/copy.js" defer />
          <script src="/fold.js" defer />
          <script src="/dismiss.js" defer />
        </head>
        <body
          class="cf-body"
          data-copy-idle={t.layout.copy}
          data-copy-done={t.layout.copied}
          data-copy-mac={t.layout.pressToCopy("⌘C")}
          data-copy-other={t.layout.pressToCopy("Ctrl+C")}
          data-fold-more={t.layout.showMore}
          data-fold-less={t.layout.showLess}
        >
          <a href="#main" class="cf-skip">{t.layout.skip}</a>
          <header class="cf-nav">
            <nav class="cf-nav-inner" aria-label={t.layout.mainNav}>
              <a href="/" class="cf-wordmark">
                <img src="/logo.png" width="24" height="24" alt="" class="cf-wordmark-mark" />
                skillsgist
              </a>
              <span class="flex-1" />
              {props.user ? (
                <>
                  <a href="/new" class="cf-btn cf-btn-primary">{t.layout.publish}</a>
                  <AccountMenu user={props.user} />
                </>
              ) : props.hideSignIn ? null : (
                <a href="/login" class="cf-btn cf-btn-primary">{t.layout.signIn}</a>
              )}
            </nav>
          </header>
          <main id="main" class="cf-main">
            {props.bare ? props.children : <div class="cf-page cf-guides cf-page-body">{props.children}</div>}
          </main>
          <footer class="cf-footer">
            <div class="cf-footer-inner">
              <p>
                <a href="/" class="cf-footer-mark">
                  <img src="/logo.png" width="18" height="18" alt="" class="cf-wordmark-mark" />
                  skillsgist
                </a>
                <span>{t.layout.tagline}</span>
              </p>
              <div class="cf-footer-end">
                <LanguageForm />
                <nav class="cf-footer-links" aria-label={t.layout.footerNav}>
                  <a href="https://github.com/Qsnh/skillsgist">{t.layout.source}</a>
                </nav>
              </div>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}

export function PageHead(props: {
  title: unknown;
  aside?: unknown;
  compact?: boolean;
  error?: unknown;
  children?: unknown;
}) {
  const flashed = useContext(FlashContext);
  return (
    <>
      <header class={props.compact ? "cf-head cf-head-compact" : "cf-head"}>
        <div class="cf-head-row">
          <h1 class="cf-head-title">{props.title}</h1>
          {props.aside}
        </div>
        {props.children ? <div class="cf-head-lede">{props.children}</div> : null}
      </header>
      <Done message={flashed} />
      <Alert message={props.error} />
    </>
  );
}

export function Panel(props: {
  title?: unknown;
  aside?: unknown;
  foot?: unknown;
  flush?: boolean;
  children?: unknown;
}) {
  return (
    <section class="cf-frame cf-panel">
      {props.title ? (
        <header class="cf-panel-head">
          <h2 class="cf-panel-title">{props.title}</h2>
          {props.aside}
        </header>
      ) : null}
      {props.flush ? props.children : <div class="cf-panel-body">{props.children}</div>}
      {props.foot}
    </section>
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  value?: string;
  hint?: unknown;
  autocomplete?: string;
  code?: boolean;
}) {
  return (
    <label class="cf-field">
      <span class="cf-label">{props.label}</span>
      <input
        class={props.code ? "cf-input cf-input-code" : "cf-input"}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        autocomplete={props.autocomplete}
        autocapitalize={props.code ? "characters" : undefined}
        spellcheck={props.code ? false : undefined}
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
  variant?: "primary" | "outline" | "danger" | "ghost";
  size?: "sm";
  wide?: boolean;
  name?: string;
  value?: string;
  children?: unknown;
}) {
  const variant = props.variant ?? "primary";
  const classes = ["cf-btn", `cf-btn-${variant}`, props.size ? "cf-btn-sm" : "", props.wide ? "cf-btn-wide" : ""];
  return (
    <button type="submit" class={classes.filter(Boolean).join(" ")} name={props.name} value={props.value}>
      {props.children}
    </button>
  );
}

export function ConfirmDelete(props: {
  action: string;
  label: string;
  confirm: string;
  size?: "sm";
  ghost?: boolean;
  icon?: unknown;
  name?: string;
  children?: unknown;
}) {
  const variant = props.ghost ? "cf-btn-ghost cf-btn-ghost-danger" : "cf-btn-danger";
  const summary = ["cf-btn", variant, props.size ? "cf-btn-sm" : ""].filter(Boolean).join(" ");
  return (
    <details class="cf-confirm" name={props.name}>
      <summary class={summary}>
        {props.icon}
        {props.label}
      </summary>
      <div class="cf-confirm-panel">
        <p class="cf-hint">{props.children}</p>
        <Form action={props.action}>
          <Button variant="danger" size={props.size}>{props.confirm}</Button>
        </Form>
      </div>
    </details>
  );
}

export function AlertIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11h.01" />
    </Icon>
  );
}

export function Alert(props: { message?: unknown }) {
  if (!props.message) return null;
  return (
    <p class="cf-alert" role="alert">
      <AlertIcon />
      <span>{props.message}</span>
    </p>
  );
}

export function Done(props: { message?: string }) {
  if (!props.message) return null;
  return (
    <p class="cf-done" role="status">
      <Icon>
        <circle cx="8" cy="8" r="6" />
        <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
      </Icon>
      <span>{props.message}</span>
    </p>
  );
}

export function CodeBlock(props: { prompt?: boolean; raised?: boolean; children?: unknown }) {
  const t = useT();
  return (
    <div class={props.raised ? "cf-command cf-command-raised" : "cf-command cf-command-flat"} data-copy>
      {props.prompt === false ? null : <span class="cf-command-prompt" aria-hidden="true">$</span>}
      <code class="cf-command-text">{props.children}</code>
      <button type="button" class="cf-command-copy" hidden>
        <Icon>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </Icon>
        <span class="cf-command-copy-label">{t.layout.copy}</span>
      </button>
      <span class="cf-command-status sr-only" role="status" />
    </div>
  );
}
