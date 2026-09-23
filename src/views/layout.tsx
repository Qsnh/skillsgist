import { raw } from "hono/html";
import { Form } from "../csrf";
import { DISCOVERY_SCHEMA } from "../registry";
import type { UserRow } from "../db/queries";

const SCHEMA_VERSION = DISCOVERY_SCHEMA.split("/").at(-2) ?? "";

export function Layout(props: { title: string; user: UserRow | null; children?: unknown }) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#fbfbf9" />
          <title>{props.title} · skillsgist</title>
          <link rel="preload" href="/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href="/app.css" />
        </head>
        <body>
          <div class="sheet">
            <header class="masthead">
              <a href="/" class="masthead__mark">skillsgist</a>
              <nav class="masthead__fields">
                {props.user ? (
                  <>
                    <a href="/new" class="field-cell"><span class="legend">Publish</span></a>
                    {props.user.role === "admin" ? (
                      <a href="/admin/users" class="field-cell"><span class="legend">Users</span></a>
                    ) : null}
                    <a href="/me" class="field-cell">
                      <span class="field-cell__user">{props.user.username}</span>
                    </a>
                    <Form action="/logout">
                      <button type="submit" class="field-cell"><span class="legend">Sign out</span></button>
                    </Form>
                  </>
                ) : (
                  <a href="/login" class="field-cell"><span class="legend">Sign in</span></a>
                )}
              </nav>
            </header>
            <main class="sheet__main">{props.children}</main>
            <footer class="colophon">
              <span class="legend">Discovery</span>
              <a href="/.well-known/agent-skills/index.json" class="colophon__value">
                /.well-known/agent-skills/index.json
              </a>
              <span class="legend">Schema {SCHEMA_VERSION}</span>
            </footer>
          </div>
        </body>
      </html>
    </>
  );
}

/** The class diamond: filled amber for private, drawn open for public. */
export function ClassMark(props: { visibility: "public" | "private" }) {
  return (
    <span class={`class-mark class-mark--${props.visibility}`}>
      <svg class="class-mark__glyph" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 1.6 22.4 12 12 22.4 1.6 12Z" stroke-width="1.6" stroke-linejoin="round" />
      </svg>
      <span class="legend">{props.visibility}</span>
    </span>
  );
}

/** The ruled title row every route opens with. */
export function PageHead(props: { title: string; aside?: unknown }) {
  return (
    <div class="band band--head">
      <div class="band__head band__head--flush">
        <h1 class="legend">{props.title}</h1>
        {props.aside ? <span class="legend">{props.aside}</span> : null}
      </div>
    </div>
  );
}

/** A ruled compartment: a legend naming the field, then its content. */
export function Band(props: { legend: string; aside?: unknown; bleed?: boolean; children?: unknown }) {
  return (
    <section class={props.bleed ? "band band--bleed" : "band"}>
      <div class="band__head">
        <span class="legend">{props.legend}</span>
        {props.aside ? <span class="legend">{props.aside}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

export function Field(props: { label: string; name: string; type?: string; value?: string; hint?: string }) {
  return (
    <label class="label-field">
      <span class="legend">{props.label}</span>
      <span class="channel channel--boxed">
        <input
          class="channel__input"
          name={props.name}
          type={props.type ?? "text"}
          value={props.value}
          required
        />
      </span>
      {props.hint ? <span class="label-field__hint">{props.hint}</span> : null}
    </label>
  );
}

export function Button(props: { children?: unknown }) {
  return (
    <button type="submit" class="label-button">
      <span class="legend">{props.children}</span>
    </button>
  );
}

/** Renders nothing without a message, so call sites need no `? :` around it. */
export function Alert(props: { message?: string }) {
  if (!props.message) return null;
  return <p class="label-alert">{props.message}</p>;
}

/** For install commands and generated tokens. */
export function CodeBlock(props: { children?: unknown }) {
  return <code class="dispense" tabindex={0}>{props.children}</code>;
}
