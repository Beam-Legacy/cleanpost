import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { isRedactedKey, redactDeep, serializeError } from './redact';

export { REDACTED, REDACTED_KEYS, isRedactedKey, redactDeep, serializeError } from './redact';
export type { Logger } from 'pino';

function destinationFromEnv(): DestinationStream | undefined {
  const file = process.env.CLEANPOST_LOG_FILE;
  return file ? pino.destination({ dest: file, append: true, sync: true, mkdir: true }) : undefined;
}

export interface CreateLoggerOptions {
  /** Component name, e.g. 'web', 'worker', 'db'. */
  name: string;
  level?: string;
  /** Override the output stream (tests). Defaults to CLEANPOST_LOG_FILE if set, else stdout. */
  destination?: DestinationStream;
}

export function createLogger({ name, level, destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Every merging object goes through deep redaction before serialisation.
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
    },
    // Replace pino's default error serializer, which copies message, stack and every property.
    serializers: {
      err: (v: unknown) => (v instanceof Error ? serializeError(v) : v),
      error: (v: unknown) => (v instanceof Error ? serializeError(v) : v),
    },
  };
  return pino(options, destination ?? destinationFromEnv());
}

/** Default logger for code that has no better name. Prefer createLogger({ name }). */
export const log: Logger = createLogger({ name: 'cleanpost' });

/** True if a key would be redacted; exported for tests and for code building log context. */
export const wouldRedact = isRedactedKey;
