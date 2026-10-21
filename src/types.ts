import type { Config } from "./config";
import type { Db } from "./db/database";
import type { CountryLookup } from "./geoip";
import type { RateLimiters } from "./rate-limit";
import type { Storage } from "./storage";

export interface Services {
  db: Db;
  storage: Storage;
  geoip: CountryLookup;
  config: Config;
  limiters: RateLimiters;
}

export interface Env extends Services {
  clientIp: string | null;
}
