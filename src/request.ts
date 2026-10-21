import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { Ctx } from "./auth";
import type { Config } from "./config";

const MAX_USER_AGENT = 512;

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d+)?$/;

export function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  ip = BRACKETED_IPV6.exec(ip)?.[1] ?? IPV4_WITH_PORT.exec(ip)?.[1] ?? ip;
  ip = IPV4_MAPPED.exec(ip)?.[1] ?? ip;
  return isIP(ip) ? ip.toLowerCase() : null;
}

export function clientAddress(socketAddress: string | undefined, forwardedFor: string | undefined, trustProxy: number): string | null {
  const hops = [socketAddress];
  if (trustProxy > 0 && forwardedFor) hops.push(...forwardedFor.split(",").reverse());
  return normalizeIp(hops[Math.min(trustProxy, hops.length - 1)]);
}

export const ipOf = (c: Ctx): string | null => c.env.clientIp;

export const countryOf = (c: Ctx): string | null => c.env.geoip.country(c.env.clientIp);

export const userAgentOf = (c: Ctx): string | null => c.req.header("User-Agent")?.slice(0, MAX_USER_AGENT) || null;

const FORWARDED_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

const lastValue = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value.join(",") : value)?.split(",").pop()?.trim() || undefined;

export function requestOrigin(headers: IncomingHttpHeaders, config: Pick<Config, "publicUrl" | "trustProxy">): string | null {
  if (config.publicUrl) return config.publicUrl;
  if (config.trustProxy === 0) return null;
  const proto = lastValue(headers["x-forwarded-proto"])?.toLowerCase();
  const host = lastValue(headers["x-forwarded-host"]) ?? headers.host;
  if (proto !== "http" && proto !== "https") return null;
  if (!host || !FORWARDED_HOST.test(host)) return null;
  return `${proto}://${host}`;
}

export function withOrigin(url: string | undefined, origin: string): string | undefined {
  if (!url) return url;
  if (url.startsWith("/")) return `${origin}${url}`;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const parsed = new URL(url);
      return `${origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }
  return url;
}

export function joinedHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}
