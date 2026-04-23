export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel) {
    this.level = level;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LOG_ORDER[level] < LOG_ORDER[this.level]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(fields ?? {})
    };
    const text = JSON.stringify(payload);
    if (level === "error" || level === "warn") {
      console.error(text);
      return;
    }
    console.log(text);
  }
}
