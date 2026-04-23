import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

type LoggerOptions = {
  destination?: DestinationStream;
  bindings?: Record<string, unknown>;
};

export class Logger {
  private logger: PinoLogger;

  constructor(level: LogLevel, options: LoggerOptions = {}) {
    this.logger = pino(
      {
        level,
        base: options.bindings ?? undefined,
        timestamp: pino.stdTimeFunctions.isoTime
      },
      options.destination
    );
  }

  private static fromPino(logger: PinoLogger): Logger {
    const instance = Object.create(Logger.prototype) as Logger;
    instance.logger = logger;
    return instance;
  }

  child(bindings: Record<string, unknown>): Logger {
    return Logger.fromPino(this.logger.child(bindings));
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.logger.debug(fields ?? {}, message);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.logger.info(fields ?? {}, message);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.logger.warn(fields ?? {}, message);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.logger.error(fields ?? {}, message);
  }
}

export function createLogger(level: LogLevel, options: LoggerOptions = {}): Logger {
  return new Logger(level, options);
}
