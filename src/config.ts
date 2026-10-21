import { join, resolve } from "node:path";

export interface UploadLimits {
  uploadBytes: number;
  unpackedBytes: number;
  files: number;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface Config {
  port: number;
  host: string;
  publicUrl: string | null;
  trustProxy: number;
  dataDir: string;
  databasePath: string;
  sessionSecret: string;
  s3: S3Config;
  retentionDays: number;
  geoip: { path: string; autoUpdate: boolean };
  limits: UploadLimits;
}

export const DEFAULT_RETENTION_DAYS = 90;

export const DEFAULT_LIMITS: UploadLimits = {
  uploadBytes: 50 * 1024 * 1024,
  unpackedBytes: 200 * 1024 * 1024,
  files: 2000,
};

const MIN_SECRET_LENGTH = 32;
const MB = 1024 * 1024;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Source = Record<string, string | undefined>;

export function loadConfig(source: Source = process.env): Config {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
  const required = (name: string): string => {
    const value = read(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value ?? "";
  };
  const whole = (name: string, fallback: number, min: number): number => {
    const value = read(name);
    if (value === undefined) return fallback;
    if (!/^[0-9]{1,9}$/.test(value) || Number(value) < min) {
      problems.push(`${name} must be a whole number of at least ${min}, got "${value}"`);
      return fallback;
    }
    return Number(value);
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const value = read(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    problems.push(`${name} must be true or false, got "${value}"`);
    return fallback;
  };

  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret && sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters; try \`openssl rand -hex 32\``);
  }

  const dataDir = dataDirFrom(source);
  const endpoint = read("S3_ENDPOINT") ?? "";
  if (endpoint && !/^https?:\/\/[^/]+\/?$/.test(endpoint)) {
    problems.push(`S3_ENDPOINT must be a URL with no path, such as http://s3:8333, got "${endpoint}"`);
  }

  const config: Config = {
    port: whole("PORT", 3000, 1),
    host: read("HOST") ?? "0.0.0.0",
    publicUrl: publicUrl(read("PUBLIC_URL"), problems),
    trustProxy: trustProxy(read("TRUST_PROXY"), problems),
    dataDir,
    databasePath: databasePathFrom(source),
    sessionSecret,
    s3: {
      endpoint: endpoint.replace(/\/$/, ""),
      region: read("S3_REGION") ?? "us-east-1",
      bucket: required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: flag("S3_FORCE_PATH_STYLE", endpoint !== ""),
    },
    retentionDays: whole("DOWNLOAD_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1),
    geoip: {
      path: resolve(read("GEOIP_DB_PATH") ?? join(dataDir, "dbip-country-lite.mmdb")),
      autoUpdate: flag("GEOIP_AUTO_UPDATE", true),
    },
    limits: {
      uploadBytes: whole("MAX_UPLOAD_MB", DEFAULT_LIMITS.uploadBytes / MB, 1) * MB,
      unpackedBytes: whole("MAX_UNPACKED_MB", DEFAULT_LIMITS.unpackedBytes / MB, 1) * MB,
      files: whole("MAX_FILES", DEFAULT_LIMITS.files, 1),
    },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

const dataDirFrom = (source: Source) => resolve(source.DATA_DIR?.trim() || "data");

export const databasePathFrom = (source: Source = process.env) =>
  resolve(source.DATABASE_PATH?.trim() || join(dataDirFrom(source), "skillsgist.db"));

function publicUrl(value: string | undefined, problems: string[]): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`PUBLIC_URL must be an absolute URL such as https://skills.example.com, got "${value}"`);
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    problems.push(`PUBLIC_URL must be an http(s) origin with no path, got "${value}"`);
    return null;
  }
  return url.origin;
}

function trustProxy(value: string | undefined, problems: string[]): number {
  if (value === undefined) return 0;
  const lower = value.toLowerCase();
  if (lower === "true") return 1;
  if (lower === "false") return 0;
  if (/^[0-9]{1,2}$/.test(value)) return Number(value);
  problems.push(`TRUST_PROXY must be true, false or the number of proxies in front of the app, got "${value}"`);
  return 0;
}
