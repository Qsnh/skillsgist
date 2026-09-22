import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds on /healthz", async () => {
  const res = await SELF.fetch("http://localhost/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

// Final-review Fix 4a: the markdown sanitizer's tag layer moved from a
// blocklist to an allowlist (see test/markdown.test.ts), but sanitized
// HTML is rendered once at publish time and stored — a future sanitizer
// improvement never retroactively cleans what's already in the database.
// A CSP header makes any residual or future bypass inert at zero CPU
// cost, on every HTML page regardless of which route rendered it.
it("sets a restrictive CSP header on HTML page responses", async () => {
  const res = await SELF.fetch("http://localhost/login");
  expect(res.headers.get("Content-Type")).toContain("text/html");
  expect(res.headers.get("Content-Security-Policy")).toBe(
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
});

it("does not set a CSP header on a JSON response", async () => {
  const res = await SELF.fetch("http://localhost/.well-known/agent-skills/index.json");
  expect(res.headers.get("Content-Security-Policy")).toBeNull();
});
