/**
 * Synthetic identity pools. Every generator in this repo draws names, dates of birth and member IDs
 * from here, so the log scanner can recognise any of them if they leak into logs, job payloads or
 * error messages. Never add real people's names.
 *
 * The first entries match the synthetic world used by the UI reference (ui/CONVENTIONS.md).
 */
export const SYNTHETIC_LAST_NAMES = [
  'Nguyen',
  'Rivera',
  'Okafor',
  'Hart',
  'Lindqvist',
  'Patel',
  'Shah',
  'Brooks',
  'Moreno',
  'Alvarez',
  'Thornbury',
  'Castellano',
  'Achterberg',
  'Whitlock',
  'Dellacroix',
  'Ferreira',
  'Kowalczyk',
  'Abernathy',
  'Quintero',
  'Valdivia',
] as const;

export const SYNTHETIC_FIRST_NAMES = [
  'Mai',
  'Ana',
  'Tobenna',
  'Jonah',
  'Elin',
  'Ravi',
  'Nadia',
  'Keegan',
  'Lucia',
  'Sofia',
  'Wendell',
  'Marisol',
  'Henrike',
  'Odette',
  'Florian',
  'Ignacio',
  'Beatrix',
  'Cormac',
  'Esperanza',
  'Thaddeus',
] as const;

/** Synthetic member IDs always look like XQ + 8 digits, a format no payer uses. */
export const SYNTHETIC_MEMBER_ID_PATTERN = /\bXQ\d{8}\b/;

export function syntheticMemberId(n: number): string {
  return `XQ${String(n % 100_000_000).padStart(8, '0')}`;
}

/**
 * Synthetic dates of birth fall between 1930 and 2015. Dates of service are 2024 or later, so a
 * full date in the DOB range inside a log line is treated as a leaked date of birth.
 */
export const DOB_PATTERN = /\b(19[3-9]\d|200\d|201[0-5])-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
