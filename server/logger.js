import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "scanner-core" },
  redact: {
    paths: ["authorization", "consumerSecret", "accessToken", "token", "req.headers.authorization"],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
