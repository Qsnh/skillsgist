import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { app } from "./app";
import { ConfigError, loadConfig } from "./config";
import { openDatabase } from "./db/database";
import { GeoIp } from "./geoip";
import { runMaintenance, scheduleHourly } from "./maintenance";
import { createRateLimiters } from "./rate-limit";
import { clientAddress, joinedHeader, requestOrigin, withOrigin } from "./request";
import { S3Storage, StorageError } from "./storage";
import type { Services } from "./types";

const BUCKET_ATTEMPTS = 20;
const BUCKET_RETRY_MS = 3000;
const KEEP_ALIVE_MS = 65_000;

async function ensureBucket(storage: S3Storage, bucket: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const state = await storage.ensureBucket();
      console.log(state === "created" ? `created the S3 bucket ${bucket}` : `using the S3 bucket ${bucket}`);
      return;
    } catch (err) {
      if (err instanceof StorageError && (err.status === 401 || err.status === 403)) throw err;
      if (attempt === BUCKET_ATTEMPTS) throw err;
      const reason = err instanceof StorageError ? err.message : `S3 is not reachable yet: ${(err as Error).message}`;
      console.warn(`${reason} (attempt ${attempt} of ${BUCKET_ATTEMPTS})`);
      await sleep(BUCKET_RETRY_MS);
    }
  }
}

async function updateGeoIp(geoip: GeoIp): Promise<void> {
  try {
    const month = await geoip.update();
    if (month) console.log(`downloaded the DB-IP country database for ${month}`);
  } catch (err) {
    console.warn(`GeoIP update failed; countries stay ${geoip.loaded ? "on the current database" : "unknown"}`, err);
  }
}

let shutdown = (signal: string): void => {
  console.log(`${signal} received before startup finished, exiting`);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const storage = new S3Storage(config.s3);
  await ensureBucket(storage, config.s3.bucket);
  const geoip = new GeoIp(config.geoip.path);
  if (!geoip.load() && !config.geoip.autoUpdate) {
    console.warn(`no GeoIP database at ${config.geoip.path}; download countries stay unknown`);
  }
  if (config.geoip.autoUpdate) void updateGeoIp(geoip);

  const services: Services = { db, storage, geoip, config, limiters: createRateLimiters() };
  const listener = getRequestListener((request, node) =>
    app.fetch(request, {
      ...services,
      clientIp: clientAddress(node.incoming.socket.remoteAddress, joinedHeader(node.incoming.headers, "x-forwarded-for"), config.trustProxy),
    }),
  );
  const server = createServer((req, res) => {
    const origin = requestOrigin(req.headers, config);
    if (origin) req.url = withOrigin(req.url, origin);
    void listener(req, res);
  });

  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 1000;

  const stopMaintenance = scheduleHourly(async () => {
    const report = await runMaintenance(services);
    if (report.prunedLogs > 0 || report.staleLogins > 0) {
      console.log(`maintenance removed ${report.prunedLogs} old download records and ${report.staleLogins} stale CLI sign-ins`);
    }
    if (config.geoip.autoUpdate) await updateGeoIp(geoip);
  });

  server.listen(config.port, config.host, () => {
    console.log(`skillsgist is listening on http://${config.host}:${config.port}${config.publicUrl ? ` (public URL ${config.publicUrl})` : ""}`);
  });

  let closing = false;
  shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    stopMaintenance();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error("skillsgist failed to start", err);
  }
  process.exit(1);
});
