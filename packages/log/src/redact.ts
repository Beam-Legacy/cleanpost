/**
 * Keys whose values are never written to logs, at any depth. Matching ignores case, underscores and
 * dashes, so `memberId`, `member_id` and `MEMBER-ID` are all caught.
 *
 * Logs should carry record IDs only; this list is the safety net for when something slips through.
 */
export const REDACTED_KEYS = [
  // Patient and subscriber identity
  'firstName',
  'lastName',
  'middleName',
  'fullName',
  'patientName',
  'patientFullName',
  'subscriberName',
  'name',
  'dob',
  'dateOfBirth',
  'birthDate',
  'ssn',
  'memberId',
  'groupNumber',
  'subscriber',
  'patient',
  'address',
  'line1',
  'line2',
  'phone',
  'email',
  'taxId',
  // Clinical and claim content that identifies a person in context
  'diagnoses',
  'notes',
  'raw835',
  'payload',
  // Database error details and query parameters can echo row values
  'params',
  'parameters',
  'detail',
  'values',
  // Secrets
  'password',
  'token',
  'secret',
  'customerKey',
  'credentials',
  'authorization',
  'cookie',
  'apiKey',
] as const;

export const REDACTED = '[redacted]';

const normalise = (key: string) => key.toLowerCase().replace(/[-_]/g, '');
const REDACTED_SET = new Set<string>(REDACTED_KEYS.map(normalise));

export function isRedactedKey(key: string): boolean {
  return REDACTED_SET.has(normalise(key));
}

/** Returns a copy of `value` with every redacted key replaced, at any depth. Handles cycles. */
export function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
  if (value instanceof Date) return value;
  if (value instanceof Error) return serializeError(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isRedactedKey(k) ? REDACTED : redactDeep(v, seen);
  }
  return out;
}

/**
 * Errors are reduced to type, code and stack, wherever they appear in a log object. Driver errors
 * (Postgres, Drizzle) put row values in `detail`, `params` and sometimes `message`, so the message
 * is kept only for errors without driver fields. Set `safeMessage` on an error to log a vetted text.
 */
export function serializeError(err: Error): Record<string, unknown> {
  const e = err as Error & { code?: unknown; safeMessage?: unknown };
  const fromDriver =
    'detail' in e || 'params' in e || 'severity' in e || 'query' in e || e.constructor.name.includes('Query');
  return {
    type: e.constructor.name,
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.safeMessage === 'string' ? e.safeMessage : fromDriver ? REDACTED : e.message,
    stack: e.stack?.split('\n').slice(1).join('\n'),
    cause: e.cause instanceof Error ? serializeError(e.cause) : undefined,
  };
}
