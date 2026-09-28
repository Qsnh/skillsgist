import { expect, it } from "vitest";
import { get } from "./helpers";

it("responds on /healthz", async () => {
  const res = await get("/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

// Pins the exact policy, `img-src` included: without its own directive it
// falls back to `default-src 'self'` and a real browser refuses the external
// images the sanitizer deliberately preserves. Rationale: src/index.ts.
it("sets a restrictive CSP header on HTML page responses", async () => {
  const res = await get("/login");
  expect(res.headers.get("Content-Type")).toContain("text/html");
  expect(res.headers.get("Content-Security-Policy")).toBe(
    "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
});

it("does not set a CSP header on a JSON response", async () => {
  const res = await get("/.well-known/agent-skills/index.json");
  expect(res.headers.get("Content-Security-Policy")).toBeNull();
});

// Quirks mode would change the box model out from under Tailwind (see
// src/views/layout.tsx). Every page goes through the same Layout, so
// asserting one is enough to pin it.
it("renders pages through the shared Layout: a doctype, same-origin deferred scripts, the mark, no Registry tag or discovery link", async () => {
  const html = await (await get("/login")).text();
  expect(html.slice(0, 40)).toMatch(/^<!DOCTYPE html>\s*<html lang="en">/);
  expect(html).toContain(`<script src="/copy.js" defer=""></script>`);
  expect(html).toContain(`<script src="/fold.js" defer=""></script>`);
  expect(html).toContain(`<script src="/dismiss.js" defer=""></script>`);
  expect(html).not.toContain(`<span class="cf-tag cf-nav-tag">`);
  expect(html).not.toContain("Public discovery index");
  expect(html).toContain(`<a href="https://github.com/Qsnh/skillsgist">Source on GitHub</a>`);
  expect(html).toContain(`<link rel="icon" type="image/png" href="/favicon.png"/>`);
  expect(html).toContain(`<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>`);
  expect(html).toContain(
    `<a href="/" class="cf-wordmark"><img src="/logo.png" width="24" height="24" alt="" class="cf-wordmark-mark"/>skillsgist</a>`,
  );
  expect(html).toContain(
    `<a href="/" class="cf-footer-mark"><img src="/logo.png" width="18" height="18" alt="" class="cf-wordmark-mark"/>skillsgist</a>`,
  );
  expect(html).toContain(`<meta property="og:title" content="Sign in · skillsgist"/>`);
  expect(html).toContain(`<meta property="og:image" content="http://localhost/og.png"/>`);
  expect(html).toContain(`<meta name="twitter:card" content="summary_large_image"/>`);
  expect(html).toContain(
    `<img src="/logo.png" width="48" height="48" alt="" class="cf-auth-mark"/><h1 class="cf-auth-title">Sign in</h1>`,
  );
});
