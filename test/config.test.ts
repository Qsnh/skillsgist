import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, databasePathFrom, DEFAULT_LIMITS, DEFAULT_RETENTION_DAYS, loadConfig } from "../src/config";

const SECRET = "x".repeat(32);

const REQUIRED = {
  SESSION_SECRET: SECRET,
  S3_BUCKET: "skillsgist",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

const problems = (source: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(source);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
};

describe("loadConfig", () => {
  it("fills in defaults around the required settings", () => {
    const config = loadConfig({ ...REQUIRED, DATA_DIR: "/srv/skillsgist" });
    expect(config).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      publicUrl: null,
      trustProxy: 0,
      dataDir: "/srv/skillsgist",
      databasePath: "/srv/skillsgist/skillsgist.db",
      sessionSecret: SECRET,
      retentionDays: DEFAULT_RETENTION_DAYS,
      geoip: { path: "/srv/skillsgist/dbip-country-lite.mmdb", autoUpdate: true },
      limits: DEFAULT_LIMITS,
    });
    expect(config.s3).toEqual({
      endpoint: "",
      region: "us-east-1",
      bucket: "skillsgist",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: false,
    });
  });

  it("names every missing required setting at once", () => {
    expect(problems({})).toEqual([
      "SESSION_SECRET is required",
      "S3_BUCKET is required",
      "S3_ACCESS_KEY_ID is required",
      "S3_SECRET_ACCESS_KEY is required",
    ]);
  });

  it("rejects a short session secret", () => {
    expect(problems({ ...REQUIRED, SESSION_SECRET: "short" })).toEqual([expect.stringContaining("at least 32 characters")]);
  });

  it("uses path-style S3 addresses for a custom endpoint unless told otherwise", () => {
    const custom = { ...REQUIRED, S3_ENDPOINT: "http://s3:8333/" };
    expect(loadConfig(custom).s3).toMatchObject({ endpoint: "http://s3:8333", forcePathStyle: true });
    expect(loadConfig({ ...custom, S3_FORCE_PATH_STYLE: "false" }).s3.forcePathStyle).toBe(false);
    expect(problems({ ...REQUIRED, S3_ENDPOINT: "http://s3:8333/bucket" })).toEqual([expect.stringContaining("S3_ENDPOINT")]);
    expect(problems({ ...REQUIRED, S3_FORCE_PATH_STYLE: "maybe" })).toEqual([expect.stringContaining("S3_FORCE_PATH_STYLE")]);
  });

  it("keeps only the origin of PUBLIC_URL and refuses one with a path", () => {
    expect(loadConfig({ ...REQUIRED, PUBLIC_URL: "https://skills.example.com/" }).publicUrl).toBe("https://skills.example.com");
    expect(loadConfig({ ...REQUIRED, PUBLIC_URL: "http://localhost:3000" }).publicUrl).toBe("http://localhost:3000");
    expect(problems({ ...REQUIRED, PUBLIC_URL: "https://example.com/skills" })).toEqual([expect.stringContaining("PUBLIC_URL")]);
    expect(problems({ ...REQUIRED, PUBLIC_URL: "skills.example.com" })).toEqual([expect.stringContaining("PUBLIC_URL")]);
    expect(problems({ ...REQUIRED, PUBLIC_URL: "ftp://example.com" })).toEqual([expect.stringContaining("PUBLIC_URL")]);
  });

  it.each([
    ["true", 1],
    ["false", 0],
    ["2", 2],
  ])("reads TRUST_PROXY=%s as %d proxies", (value, hops) => {
    expect(loadConfig({ ...REQUIRED, TRUST_PROXY: value }).trustProxy).toBe(hops);
  });

  it("refuses a TRUST_PROXY it cannot read", () => {
    expect(problems({ ...REQUIRED, TRUST_PROXY: "nginx" })).toEqual([expect.stringContaining("TRUST_PROXY")]);
  });

  it("reads the retention and upload limits as whole numbers", () => {
    const config = loadConfig({
      ...REQUIRED,
      DOWNLOAD_LOG_RETENTION_DAYS: " 030 ",
      MAX_UPLOAD_MB: "5",
      MAX_UNPACKED_MB: "20",
      MAX_FILES: "300",
    });
    expect(config.retentionDays).toBe(30);
    expect(config.limits).toEqual({ uploadBytes: 5 * 1024 * 1024, unpackedBytes: 20 * 1024 * 1024, files: 300 });
  });

  it("treats an empty setting as unset", () => {
    expect(loadConfig({ ...REQUIRED, DOWNLOAD_LOG_RETENTION_DAYS: "", PORT: " " })).toMatchObject({ retentionDays: 90, port: 3000 });
  });

  it.each(["0", "-3", "1.5", "abc", "7d", "1e3"])("refuses DOWNLOAD_LOG_RETENTION_DAYS=%j", (value) => {
    expect(problems({ ...REQUIRED, DOWNLOAD_LOG_RETENTION_DAYS: value })).toEqual([
      expect.stringContaining("DOWNLOAD_LOG_RETENTION_DAYS"),
    ]);
  });

  it("can turn GeoIP updates off and point at another database", () => {
    expect(loadConfig({ ...REQUIRED, GEOIP_AUTO_UPDATE: "off", GEOIP_DB_PATH: "/geo/GeoLite2-Country.mmdb" }).geoip).toEqual({
      path: "/geo/GeoLite2-Country.mmdb",
      autoUpdate: false,
    });
  });

  it("places the database in the data directory unless DATABASE_PATH says otherwise", () => {
    expect(databasePathFrom({})).toBe(resolve("data/skillsgist.db"));
    expect(databasePathFrom({ DATA_DIR: "/data" })).toBe("/data/skillsgist.db");
    expect(databasePathFrom({ DATA_DIR: "/data", DATABASE_PATH: "/db/main.db" })).toBe("/db/main.db");
  });
});
