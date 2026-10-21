import { setImmediate as yieldToRequests } from "node:timers/promises";
import { PRUNE_BATCH, pruneDownloadDays, pruneDownloadLogBatch } from "./db/downloads";
import { deleteStaleLogins } from "./db/logins";
import { DAY_MS, HOUR_MS } from "./time";
import type { Services } from "./types";

export const MAINTENANCE_MINUTE = 17;

export interface MaintenanceReport {
  prunedLogs: number;
  staleLogins: number;
}

export const retentionCutoff = (days: number, now: number): number => now - days * DAY_MS;

export async function runMaintenance(
  services: Pick<Services, "db" | "config">,
  now: number = Date.now(),
): Promise<MaintenanceReport> {
  const { db } = services;
  const cutoff = retentionCutoff(services.config.retentionDays, now);
  pruneDownloadDays(db, cutoff);
  let prunedLogs = 0;
  for (;;) {
    const deleted = pruneDownloadLogBatch(db, cutoff);
    prunedLogs += deleted;
    if (deleted < PRUNE_BATCH) break;
    await yieldToRequests();
  }
  const staleLogins = deleteStaleLogins(db, now);
  db.pragma("optimize");
  return { prunedLogs, staleLogins };
}

export function msUntilNextRun(now: number): number {
  const next = new Date(now);
  next.setUTCMinutes(MAINTENANCE_MINUTE, 0, 0);
  if (next.getTime() <= now) next.setTime(next.getTime() + HOUR_MS);
  return next.getTime() - now;
}

export function scheduleHourly(task: () => void | Promise<void>): () => void {
  let interval: NodeJS.Timeout | undefined;
  const run = async () => {
    try {
      await task();
    } catch (err) {
      console.error("hourly maintenance failed", err);
    }
  };
  const first = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), HOUR_MS);
    interval.unref();
  }, msUntilNextRun(Date.now()));
  first.unref();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
