import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}]${extra} ${message}`;
});

export function createLogger(level = "info"): winston.Logger {
  return winston.createLogger({
    level,
    format: combine(timestamp({ format: "HH:mm:ss.SSS" }), colorize(), logFormat),
    transports: [new winston.transports.Console()],
  });
}

export const log = createLogger(process.env.LOG_LEVEL || "info");
