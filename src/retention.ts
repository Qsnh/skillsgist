import { DAY_MS } from "./time";
import type { Env } from "./types";

export const DEFAULT_RETENTION_DAYS = 90;

const WHOLE_DAYS = /^[0-9]{1,6}$/;

export function retentionDays(env: Pick<Env, "DOWNLOAD_LOG_RETENTION_DAYS">): number {
  const raw = env.DOWNLOAD_LOG_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const value = String(raw).trim();
  if (WHOLE_DAYS.test(value) && Number(value) >= 1) return Number(value);
  console.error(`DOWNLOAD_LOG_RETENTION_DAYS must be a positive whole number; keeping ${DEFAULT_RETENTION_DAYS} days`, raw);
  return DEFAULT_RETENTION_DAYS;
}

export const retentionCutoff = (days: number, now: number): number => now - days * DAY_MS;
