import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { ORIGIN } from "./helpers";

it("responds on /healthz", async () => {
  const res = await SELF.fetch(`${ORIGIN}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

// Pins the exact policy, `img-src` included: without its own directive it
// falls back to `default-src 'self'` and a real browser refuses the external
// images the sanitizer deliberately preserves. Rationale: src/index.ts.
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

// Quirks mode would change the box model out from under Tailwind (see
// src/views/layout.tsx). Every page goes through the same Layout, so
// asserting one is enough to pin it.
it("starts HTML pages with a doctype so browsers don't use quirks mode", async () => {
  const html = await (await SELF.fetch(`${ORIGIN}/login`)).text();
  expect(html.slice(0, 40)).toMatch(/^<!DOCTYPE html>\s*<html lang="zh-CN">/);
});
