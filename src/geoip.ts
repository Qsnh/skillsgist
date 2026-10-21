import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { Reader } from "mmdb-lib";
import type { CountryResponse } from "mmdb-lib";
import { DAY_MS } from "./time";

export interface CountryLookup {
  country(ip: string | null): string | null;
}

export const GEOIP_MAX_AGE_MS = 30 * DAY_MS;

const DOWNLOAD_TIMEOUT_MS = 120_000;

export const dbipUrl = (month: string) => `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

function recentMonths(now: Date): string[] {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [monthOf(now), monthOf(previous)];
}

export class GeoIp implements CountryLookup {
  private reader: Reader<CountryResponse> | null = null;

  constructor(
    private readonly path: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get loaded(): boolean {
    return this.reader !== null;
  }

  load(): boolean {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    this.reader = new Reader<CountryResponse>(bytes);
    return true;
  }

  country(ip: string | null): string | null {
    if (!ip || !this.reader) return null;
    try {
      const found = this.reader.get(ip);
      return found?.country?.iso_code ?? found?.registered_country?.iso_code ?? null;
    } catch {
      return null;
    }
  }

  isStale(now: number): boolean {
    try {
      return now - statSync(this.path).mtimeMs >= GEOIP_MAX_AGE_MS;
    } catch {
      return true;
    }
  }

  async update(now: Date = new Date()): Promise<string | null> {
    if (!this.isStale(now.getTime())) return null;
    const failures: string[] = [];
    for (const month of recentMonths(now)) {
      const url = dbipUrl(month);
      const res = await this.fetcher(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel();
        failures.push(`${url} answered ${res.status}`);
        continue;
      }
      const bytes = gunzipSync(new Uint8Array(await res.arrayBuffer()));
      const reader = new Reader<CountryResponse>(bytes);
      mkdirSync(dirname(this.path), { recursive: true });
      const partial = `${this.path}.download`;
      writeFileSync(partial, bytes);
      renameSync(partial, this.path);
      this.reader = reader;
      return month;
    }
    throw new Error(`could not download the GeoIP database: ${failures.join("; ")}`);
  }
}
