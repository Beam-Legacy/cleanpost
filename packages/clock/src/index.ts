/**
 * Demo time (DEC-18): in local and preview, Cleanpost, the mock PM and the payer simulator share one
 * offset from the real clock, so moving the simulated date moves the whole world: claims age,
 * follow-ups come due, payments arrive on their dates. In staging and production the offset is
 * always zero and cannot be set.
 *
 * Use `now()` for business time (when a claim was sent, when an item is due). Keep `Date.now()`
 * for durations, timeouts and rate limits, and leave sign-in and sessions on real time.
 */

// On globalThis so every copy of this module in one process (Next.js bundles the server twice, for
// server and client components) and the browser's copy see the same offset.
const KEY = Symbol.for('cleanpost.clock.offsetMs');
const store = globalThis as typeof globalThis & { [KEY]?: number };
const offset = (): number => store[KEY] ?? 0;

/** Demo time may move only where there is no real patient data (CLEANPOST_ENV, default local). */
export function demoTimeAllowed(env: string | undefined = readEnv()): boolean {
  const e = env ?? 'local';
  return e === 'local' || e === 'preview' || e === 'test';
}

function readEnv(): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env?.CLEANPOST_ENV;
}

/** Business time: the real clock plus the demo offset. */
export const now = (): Date => new Date(Date.now() + offset());

export const nowMs = (): number => Date.now() + offset();

/** How far demo time is from the real clock, in milliseconds (0 outside local and preview). */
export const getOffset = (): number => offset();

/** Sets the demo offset. Refused (throws) for a non-zero offset in staging or production. */
export function setOffset(ms: number): void {
  if (!Number.isFinite(ms)) throw new Error('clock offset must be a number of milliseconds');
  if (ms !== 0 && !demoTimeAllowed()) throw new Error('demo time is only available in local and preview');
  store[KEY] = Math.trunc(ms);
}
