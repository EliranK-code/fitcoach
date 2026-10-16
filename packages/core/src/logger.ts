import { pino } from "pino";
import { loadConfig } from "./config.js";

// Never log message bodies, phone numbers, profiles or keys: these paths are redacted wherever they appear.
const REDACT = [
  "text",
  "body",
  "phone",
  "content",
  "profile",
  "summary",
  "*.text",
  "*.body",
  "*.phone",
  "*.content",
  "*.profile",
  "*.summary",
  "apiKey",
  "*.apiKey",
];

export const logger = pino({
  level: loadConfig().LOG_LEVEL,
  redact: { paths: REDACT, censor: "[redacted]" },
});
