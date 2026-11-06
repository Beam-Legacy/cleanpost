import { describe, expect, it } from 'vitest';
import { actionLabel, detailsOf, recordLabel } from './audit-display';

describe('S-13 audit wording', () => {
  it('reads a G-03 search as what kind of query and what it found, never the query', () => {
    expect(actionLabel('search.performed')).toBe('Searched');
    expect(actionLabel('search.recents_viewed')).toBe('Viewed recent records');
    expect(recordLabel('search')).toBe('Search');
    expect(
      detailsOf({
        kind: 'name',
        queryHash: '0123456789abcdef',
        found: { patients: 2, claims: 1, remittances: 0, clients: 0 },
      }),
    ).toBe('kind: name · query hash: 0123456789abcdef · found: 2 patients, 1 claim');
    expect(detailsOf({ kind: 'number', found: { patients: 0, claims: 0 } })).toBe(
      'kind: number · found: nothing',
    );
  });
});
