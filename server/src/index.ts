import { createServer } from "node:http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closeDatabase, getDatabase } from "./db/index.js";
import { purgeExpiredNonces, pruneActivity, pruneAssessments, pruneSnapshots } from "./db/repositories.js";
import { createApp } from "./api/server.js";
import { attachWebSocket } from "./realtime/socket.js";
import { ProtectionEngine } from "./pipeline/engine.js";
import { getChainService } from "./chain/service.js";

async function main(): Promise<void> {
  const db = getDatabase();
  logger.info({ path: config.databasePath }, "database ready");

  const chain = getChainService();
  const chainHealth = await chain.health();
  logger.info({ chain: chainHealth }, "chain status");

  const engine = new ProtectionEngine(db);
  const app = createApp(engine);
  const server = createServer(app);
  attachWebSocket(server);

  engine.start();

  // Housekeeping: keep the database bounded without touching anchored data.
  const housekeeping = setInterval(
    () => {
      try {
        purgeExpiredNonces(db);
        pruneSnapshots(db);
        pruneAssessments(db);
        pruneActivity(db);
      } catch (err) {
        logger.warn({ err }, "housekeeping pass failed");
      }
    },
    10 * 60 * 1_000,
  );

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  logger.info(
    { port: config.port, host: config.host, env: config.env },
    "ShieldRWA API listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    clearInterval(housekeeping);
    await engine.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled promise rejection");
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
