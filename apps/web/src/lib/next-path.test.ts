import { describe, expect, it } from 'vitest';
import { nextQuery, safeNext } from './next-path';

describe('safeNext (A-01 ?next=)', () => {
  it('keeps a path on this site, with its query', () => {
    expect(safeNext('/invite?token=abc_DEF-123')).toBe('/invite?token=abc_DEF-123');
    expect(safeNext(['/claims', '/work'])).toBe('/claims');
  });

  it('refuses other origins and odd input', () => {
    for (const bad of [
      'https://evil.test/',
      '//evil.test/x',
      '/\\evil.test',
      'javascript:alert(1)',
      'work',
      '/a\u0000b',
      '',
      undefined,
      null,
      `/${'x'.repeat(600)}`,
    ])
      expect(safeNext(bad)).toBe('/work');
  });

  it('carries next only when it is not the default', () => {
    expect(nextQuery('/work')).toBe('');
    expect(nextQuery('/invite?token=a')).toBe('?next=%2Finvite%3Ftoken%3Da');
  });
});
