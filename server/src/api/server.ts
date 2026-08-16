import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { buildRoutes } from "./routes.js";
import type { ProtectionEngine } from "../pipeline/engine.js";

export function createApp(engine: ProtectionEngine): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "256kb" }));

  if (!config.isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/health" } }));
  }

  app.use("/api", buildRoutes(engine));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  // Errors are logged with their stack but never returned to the client.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, url: req.url, method: req.method }, "unhandled request error");
    if (res.headersSent) return;
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
