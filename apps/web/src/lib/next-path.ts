/**
 * Where to go after signing in (A-01 / A-02 `?next=`): a path on this site only, never another
 * origin, so a crafted sign-in link cannot send someone elsewhere. Anything else falls back to /work.
 */
export const DEFAULT_NEXT = '/work';

export function safeNext(raw: string | string[] | null | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v.length > 500) return DEFAULT_NEXT;
  // One leading slash, then not a slash or backslash ("//host" and "/\host" are other origins).
  if (!/^\/(?![/\\])/.test(v)) return DEFAULT_NEXT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(v)) return DEFAULT_NEXT;
  try {
    const u = new URL(v, 'http://cleanpost.invalid');
    if (u.origin !== 'http://cleanpost.invalid') return DEFAULT_NEXT;
    return `${u.pathname}${u.search}`;
  } catch {
    return DEFAULT_NEXT;
  }
}

/** The query string that carries `next` to the following step, or '' for the default. */
export const nextQuery = (next: string) => (next === DEFAULT_NEXT ? '' : `?next=${encodeURIComponent(next)}`);
