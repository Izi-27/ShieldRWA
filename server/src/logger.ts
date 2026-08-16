import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.isTest ? "silent" : config.isProduction ? "info" : "debug",
  base: { service: "shieldrwa" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.privateKey",
      "*.apiKey",
      "*.signature",
    ],
    censor: "[redacted]",
  },
  transport: config.isProduction
    ? undefined
    : { target: "pino/file", options: { destination: 1 } },
});

export type Logger = typeof logger;
