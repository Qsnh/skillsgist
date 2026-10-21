import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dbipUrl, GeoIp, GEOIP_MAX_AGE_MS } from "../src/geoip";
import { DAY_MS } from "../src/time";
import { GEOIP_FIXTURE } from "./helpers";

const NOW = new Date(Date.UTC(2026, 9, 3, 12));

const tempPath = () => join(mkdtempSync(join(tmpdir(), "skillsgist-geoip-")), "country.mmdb");

function serving(files: Record<string, Uint8Array>) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body ? new Response(body) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

const fixtureGz = () => gzipSync(readFileSync(GEOIP_FIXTURE));

describe("GeoIp", () => {
  it("looks up the country of IPv4, IPv4-mapped and IPv6 addresses", () => {
    const geoip = new GeoIp(GEOIP_FIXTURE);
    expect(geoip.load()).toBe(true);
    expect(geoip.country("203.0.113.9")).toBe("NZ");
    expect(geoip.country("198.51.100.200")).toBe("DE");
    expect(geoip.country("2001:db8:1::5")).toBe("JP");
    expect(geoip.country("192.0.2.1")).toBeNull();
    expect(geoip.country("not an ip")).toBeNull();
    expect(geoip.country(null)).toBeNull();
  });

  it("knows no countries until a database is loaded", () => {
    const geoip = new GeoIp(tempPath());
    expect(geoip.load()).toBe(false);
    expect(geoip.loaded).toBe(false);
    expect(geoip.country("203.0.113.9")).toBeNull();
  });

  it("downloads this month's DB-IP database when there is none, and starts using it", async () => {
    const path = tempPath();
    const { fetcher, asked } = serving({ [dbipUrl("2026-10")]: fixtureGz() });
    const geoip = new GeoIp(path, fetcher);
    expect(await geoip.update(NOW)).toBe("2026-10");
    expect(asked).toEqual(["https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz"]);
    expect(geoip.country("203.0.113.9")).toBe("NZ");
    expect(readFileSync(path)).toEqual(readFileSync(GEOIP_FIXTURE));
  });

  it("falls back to last month's database early in a month", async () => {
    const { fetcher, asked } = serving({ [dbipUrl("2026-09")]: fixtureGz() });
    const geoip = new GeoIp(tempPath(), fetcher);
    expect(await geoip.update(NOW)).toBe("2026-09");
    expect(asked).toHaveLength(2);
  });

  it("asks for December when January's database is not out yet", async () => {
    const { fetcher, asked } = serving({});
    await expect(new GeoIp(tempPath(), fetcher).update(new Date(Date.UTC(2027, 0, 1)))).rejects.toThrow(/could not download/);
    expect(asked).toEqual([dbipUrl("2027-01"), dbipUrl("2026-12")]);
  });

  it("leaves a fresh database alone", async () => {
    const path = tempPath();
    writeFileSync(path, readFileSync(GEOIP_FIXTURE));
    const { fetcher, asked } = serving({});
    expect(await new GeoIp(path, fetcher).update(new Date())).toBeNull();
    expect(asked).toEqual([]);
  });

  it("replaces a database older than 30 days", async () => {
    const path = tempPath();
    writeFileSync(path, readFileSync(GEOIP_FIXTURE));
    const old = (NOW.getTime() - GEOIP_MAX_AGE_MS - DAY_MS) / 1000;
    utimesSync(path, old, old);
    expect(new GeoIp(path).isStale(NOW.getTime())).toBe(true);
    expect(new GeoIp(path).isStale(NOW.getTime() - 2 * DAY_MS)).toBe(false);
    const { fetcher } = serving({ [dbipUrl("2026-10")]: fixtureGz() });
    expect(await new GeoIp(path, fetcher).update(NOW)).toBe("2026-10");
  });

  it("keeps the current database when the download is not a valid one", async () => {
    const path = tempPath();
    const { fetcher } = serving({ [dbipUrl("2026-10")]: gzipSync(Buffer.from("not a database")) });
    const geoip = new GeoIp(path, fetcher);
    await expect(geoip.update(NOW)).rejects.toThrow();
    expect(geoip.loaded).toBe(false);
    expect(new GeoIp(path).load()).toBe(false);
  });
});
