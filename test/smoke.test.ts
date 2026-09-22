import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds on /healthz", async () => {
  const res = await SELF.fetch("http://localhost/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
