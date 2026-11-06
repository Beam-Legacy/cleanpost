/**
 * G-03 Global search: what a query looks like (a date of birth, a control or trace number, a name,
 * a command), and how records read in the results ("Rivera, A." and an age, never a full name or
 * date of birth unless the query was that date). Pure; packages/search runs the queries.
 */

export type QueryKind = 'empty' | 'command' | 'dob' | 'number' | 'name';

export interface ParsedQuery {
  kind: QueryKind;
  /** The query as typed, trimmed (commands: without the ">"). */
  text: string;
  /** Name queries: the surname and given-name parts to try (prefix match). */
  names?: { a: string; b: string | null; comma: boolean };
  /** Date-of-birth queries, as YYYY-MM-DD. */
  dob?: string;
}

/** Shortest query that searches records; shorter ones show recent records and commands only. */
export const MIN_QUERY = 2;

const pad = (n: number) => String(n).padStart(2, '0');

/** 3/7/1984, 03-07-1984, 1984-03-07 → 1984-03-07; anything else null. */
export function parseDob(text: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [y, m, d] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : us
      ? [Number(us[3]), Number(us[1]), Number(us[2])]
      : [0, 0, 0];
  if (!y || m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text.startsWith('>')) return { kind: 'command', text: text.slice(1).trim() };
  if (text.length < MIN_QUERY) return { kind: 'empty', text };
  const dob = parseDob(text);
  if (dob) return { kind: 'dob', text, dob };
  // Control, payer claim and trace numbers carry digits; names do not.
  if (/\d/.test(text)) return { kind: 'number', text };
  const comma = text.includes(',');
  const parts = (comma ? text.split(',') : text.split(' ')).map((p) => p.trim()).filter(Boolean);
  return { kind: 'name', text, names: { a: parts[0] ?? text, b: parts[1] ?? null, comma } };
}

/** "Rivera, A." — the most a result shows of a patient's name (G-03 rules). */
export function shortName(lastName: string, firstName: string): string {
  return `${lastName}, ${firstName.trim().charAt(0).toUpperCase()}.`;
}

/** Whole years between a date of birth and today (both YYYY-MM-DD). */
export function ageYears(dob: string, today: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** LIKE pattern for a user's text: % and _ match themselves. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface Command {
  id: string;
  label: string;
  href: string;
  /** Where it lives, or its shortcut, shown at the right. */
  hint?: string;
  /** Words it also answers to. */
  keywords?: string[];
}

/**
 * Commands match when each word of the query starts a word of their label or keywords. Matches on
 * the label come before matches that needed a keyword.
 */
export function matchCommands<T extends Command>(commands: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...commands];
  const split = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/);
  const all = (hay: string[]) => words.every((w) => hay.some((h) => h.startsWith(w)));
  const scored = commands
    .map((c) => {
      const label = split(c.label);
      return { c, score: all(label) ? 0 : all([...label, ...(c.keywords ?? []).flatMap(split)]) ? 1 : -1 };
    })
    .filter((x) => x.score >= 0);
  return scored.sort((x, y) => x.score - y.score).map((x) => x.c);
}
