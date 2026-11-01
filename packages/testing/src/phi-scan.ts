import {
  DOB_PATTERN,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
  SYNTHETIC_MEMBER_ID_PATTERN,
} from './synth/identifiers';

export type PhiFindingKind = 'synthetic_name' | 'member_id' | 'date_of_birth';

export interface PhiFinding {
  kind: PhiFindingKind;
  /** 1-based line number in the scanned text. */
  line: number;
  /** The matched token. Safe to print: it is synthetic by construction. */
  match: string;
}

const LAST_NAME_RE = new RegExp(`\\b(${SYNTHETIC_LAST_NAMES.join('|')})\\b`);
const FIRST_NAME_RE = new RegExp(`\\b(${SYNTHETIC_FIRST_NAMES.join('|')})\\b`);

/** Finds synthetic patient identifiers in text such as log output or job payloads. */
export function scanForPhi(text: string): PhiFinding[] {
  const findings: PhiFinding[] = [];
  text.split('\n').forEach((content, i) => {
    const checks: [PhiFindingKind, RegExp][] = [
      ['synthetic_name', LAST_NAME_RE],
      ['synthetic_name', FIRST_NAME_RE],
      ['member_id', SYNTHETIC_MEMBER_ID_PATTERN],
      ['date_of_birth', DOB_PATTERN],
    ];
    for (const [kind, re] of checks) {
      const m = re.exec(content);
      if (m) findings.push({ kind, line: i + 1, match: m[0] });
    }
  });
  return findings;
}
