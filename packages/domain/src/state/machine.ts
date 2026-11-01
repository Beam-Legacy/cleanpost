/**
 * Typed transition tables (docs/03-state-machines.md). A transition takes the current state and an
 * event and returns the next state, or an error result for an invalid transition. Callers persist
 * the new state and record the event with its actor; nothing writes a status directly.
 */
export type Result<T, E extends string = string> = { ok: true; value: T } | { ok: false; error: E };

export type TransitionTable<S extends string, E extends string> = Partial<Record<S, Partial<Record<E, S>>>>;

export function transition<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): Result<S, 'invalid_transition'> {
  const to = table[from]?.[event];
  return to ? { ok: true, value: to } : { ok: false, error: 'invalid_transition' };
}
