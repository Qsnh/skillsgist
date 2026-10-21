import { describe, expect, it } from "vitest";
import { clientKey, RateLimiter, retryAfterSeconds } from "../src/rate-limit";

describe("RateLimiter", () => {
  it("allows the limit within the window, then says how long to wait", () => {
    const limiter = new RateLimiter(2, 10_000);
    expect(limiter.take("a", 0)).toBe(0);
    expect(limiter.take("a", 1000)).toBe(0);
    expect(limiter.take("a", 2000)).toBe(8000);
    expect(limiter.take("b", 2000)).toBe(0);
  });

  it("frees a slot once the oldest request leaves the window", () => {
    const limiter = new RateLimiter(2, 10_000);
    limiter.take("a", 0);
    limiter.take("a", 1000);
    expect(limiter.take("a", 10_000)).toBe(0);
    expect(limiter.take("a", 10_500)).toBe(500);
  });

  it("does not count a refused request against the caller", () => {
    const limiter = new RateLimiter(1, 10_000);
    limiter.take("a", 0);
    for (let at = 1; at < 10; at++) limiter.take("a", at);
    expect(limiter.take("a", 10_000)).toBe(0);
  });

  it("rounds the wait up to whole seconds, at least one", () => {
    expect(retryAfterSeconds(1)).toBe("1");
    expect(retryAfterSeconds(8001)).toBe("9");
  });

  it("can check without counting, and count separately", () => {
    const limiter = new RateLimiter(1, 10_000);
    expect(limiter.wait("a", 0)).toBe(0);
    expect(limiter.wait("a", 0)).toBe(0);
    limiter.hit("a", 0);
    expect(limiter.wait("a", 1000)).toBe(9000);
  });
});

describe("clientKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups an IPv6 address with the rest of its /64", () => {
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
  });

  it("puts requests with no address under one key", () => {
    expect(clientKey(null)).toBe("");
  });
});
