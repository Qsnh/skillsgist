import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { ORIGIN } from "./helpers";

it("responds on /healthz", async () => {
  const res = await SELF.fetch(`${ORIGIN}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

// Final-review Fix 4a: the markdown sanitizer's tag layer moved from a
// blocklist to an allowlist (see test/markdown.test.ts), but sanitized
// HTML is rendered once at publish time and stored — a future sanitizer
// improvement never retroactively cleans what's already in the database.
// A CSP header makes any residual or future bypass inert at zero CPU
// cost, on every HTML page regardless of which route rendered it.
//
// Regression 2 (scoped re-review of the final fix wave): the original
// policy had no img-src override, so it fell back to default-src 'self'
// — but the sanitizer deliberately preserves external <img src="https://...">
// (see test/markdown.test.ts's "keeps every ordinary markdown construct
// intact"), which is the normal case for skill docs with badges or
// screenshots. A real browser would refuse to load any such image. Adding
// img-src 'self' https: fixes this; data: is deliberately not included —
// the URL-scheme allowlist in render/markdown.ts only ever lets through
// http/https/mailto, so a data: image can never survive sanitization.
it("sets a restrictive CSP header on HTML page responses", async () => {
  const res = await SELF.fetch(`${ORIGIN}/login`);
  expect(res.headers.get("Content-Type")).toContain("text/html");
  const csp = res.headers.get("Content-Security-Policy");
  expect(csp).toBe(
    "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  expect(csp).toContain("img-src 'self' https:");
});

it("does not set a CSP header on a JSON response", async () => {
  const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-skills/index.json`);
  expect(res.headers.get("Content-Security-Policy")).toBeNull();
});

// Pages used to start straight at <html>, which puts a browser in quirks mode
// and changes the box model out from under Tailwind. Every page goes through
// the same Layout, so asserting one is enough to pin it.
it("starts HTML pages with a doctype so browsers don't use quirks mode", async () => {
  const html = await (await SELF.fetch(`${ORIGIN}/login`)).text();
  expect(html.slice(0, 40)).toMatch(/^<!DOCTYPE html>\s*<html lang="zh-CN">/);
});
