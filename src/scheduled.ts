import { pruneDownloadLogs } from "./db/downloads";
import { retentionCutoff, retentionDays } from "./retention";
import type { Env } from "./types";

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  try {
    await pruneDownloadLogs(env.DB, retentionCutoff(retentionDays(env), controller.scheduledTime));
  } catch (err) {
    console.error("download log prune failed", err);
    throw err;
  }
}
