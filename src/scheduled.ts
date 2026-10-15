import { PRUNE_MAX_BATCHES, pruneDownloadLogs } from "./db/downloads";
import { retentionCutoff, retentionDays } from "./retention";
import type { Env } from "./types";

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  try {
    const { deleted, capped } = await pruneDownloadLogs(env.DB, retentionCutoff(retentionDays(env), controller.scheduledTime));
    if (capped) {
      console.warn(
        `download log prune stopped at its limit of ${PRUNE_MAX_BATCHES} batches after ${deleted} rows; the rest waits for the next run`,
      );
    }
  } catch (err) {
    console.error("download log prune failed", err);
    throw err;
  }
}
