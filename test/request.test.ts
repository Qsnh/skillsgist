import { describe, expect, it } from "vitest";
import { clientAddress, normalizeIp, requestOrigin, withOrigin } from "../src/request";

describe("normalizeIp", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    [" 203.0.113.7 ", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["203.0.113.7:51234", "203.0.113.7"],
    ["2001:DB8::1", "2001:db8::1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
  ])("reads %j as %j", (raw, ip) => {
    expect(normalizeIp(raw)).toBe(ip);
  });

  it.each([undefined, "", "unknown", "203.0.113", "evil.example"])("rejects %j", (raw) => {
    expect(normalizeIp(raw)).toBeNull();
  });
});

describe("clientAddress", () => {
  it("uses the socket address when no proxy is trusted, whatever the request claims", () => {
    expect(clientAddress("::ffff:10.0.0.2", "198.51.100.9", 0)).toBe("10.0.0.2");
  });

  it("takes the address the trusted proxy appended, not one the client wrote itself", () => {
    expect(clientAddress("10.0.0.2", "6.6.6.6, 198.51.100.9", 1)).toBe("198.51.100.9");
  });

  it("walks back one entry per trusted proxy", () => {
    expect(clientAddress("10.0.0.2", "6.6.6.6, 198.51.100.9, 172.16.0.5", 2)).toBe("198.51.100.9");
  });

  it("stops at the oldest entry when fewer proxies are in the way than trusted", () => {
    expect(clientAddress("10.0.0.2", "198.51.100.9", 3)).toBe("198.51.100.9");
    expect(clientAddress("10.0.0.2", undefined, 1)).toBe("10.0.0.2");
  });

  it("gives no address when the chosen entry is not an IP", () => {
    expect(clientAddress("10.0.0.2", "garbage", 1)).toBeNull();
  });
});

describe("requestOrigin", () => {
  const behind = { publicUrl: null, trustProxy: 1 };

  it("prefers PUBLIC_URL over anything the request says", () => {
    expect(requestOrigin({ host: "internal:3000", "x-forwarded-proto": "http" }, { publicUrl: "https://skills.example.com", trustProxy: 1 })).toBe(
      "https://skills.example.com",
    );
  });

  it("ignores forwarded headers unless a proxy is trusted", () => {
    expect(requestOrigin({ host: "a", "x-forwarded-proto": "https" }, { publicUrl: null, trustProxy: 0 })).toBeNull();
  });

  it("rebuilds the origin from the trusted proxy's headers", () => {
    expect(requestOrigin({ host: "app:3000", "x-forwarded-proto": "https", "x-forwarded-host": "skills.example.com" }, behind)).toBe(
      "https://skills.example.com",
    );
    expect(requestOrigin({ host: "skills.example.com", "x-forwarded-proto": "http, HTTPS" }, behind)).toBe("https://skills.example.com");
  });

  it("takes the value the trusted proxy wrote last, not one the client sent ahead of it", () => {
    expect(
      requestOrigin({ host: "app:3000", "x-forwarded-proto": "https", "x-forwarded-host": "evil.example, skills.example.com" }, behind),
    ).toBe("https://skills.example.com");
  });

  it("leaves the origin alone when the forwarded headers are missing or malformed", () => {
    expect(requestOrigin({ host: "skills.example.com" }, behind)).toBeNull();
    expect(requestOrigin({ host: "a", "x-forwarded-proto": "gopher" }, behind)).toBeNull();
    expect(requestOrigin({ "x-forwarded-proto": "https", "x-forwarded-host": "evil.example/path" }, behind)).toBeNull();
  });
});

describe("withOrigin", () => {
  it("puts the path and query under the given origin", () => {
    expect(withOrigin("/p/default?q=x", "https://skills.example.com")).toBe("https://skills.example.com/p/default?q=x");
    expect(withOrigin("http://internal:3000/me?a=1", "https://skills.example.com")).toBe("https://skills.example.com/me?a=1");
  });

  it("leaves anything else as it was", () => {
    expect(withOrigin("*", "https://skills.example.com")).toBe("*");
    expect(withOrigin(undefined, "https://skills.example.com")).toBeUndefined();
  });
});
