'use client';
/**
 * R-08 Code explainer: an adjustment or remark code chip that explains itself on hover or focus,
 * in our own words (not the X12 code list text) and without procedure descriptions.
 */
import { Tooltip } from '@cleanpost/ui';
import { explainCode } from '@/lib/remit-display';

export function CodeChip({ code, bad = false }: { code: string; bad?: boolean }) {
  const e = explainCode(code);
  return (
    <Tooltip
      content={
        <span className="stack-sm" style={{ display: 'flex', maxWidth: 280 }}>
          <b>{e.title}</b>
          {e.lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      }
    >
      <button
        type="button"
        className={`codechip${bad ? ' bad' : ''}`}
        aria-label={`${code}: ${e.lines.join('. ')}`}
      >
        {code}
      </button>
    </Tooltip>
  );
}
