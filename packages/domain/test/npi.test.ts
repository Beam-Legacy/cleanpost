import { describe, expect, it } from 'vitest';
import { isValidNpi, npiCheckDigit, npiFromBase } from '../src/identifiers/npi';

describe('NPI check digit', () => {
  it('matches the CMS worked example (123456789 -> 3)', () => {
    expect(npiCheckDigit('123456789')).toBe(3);
    expect(isValidNpi('1234567893')).toBe(true);
    expect(isValidNpi('1234567890')).toBe(false);
  });

  it('builds valid NPIs and rejects malformed input', () => {
    expect(isValidNpi(npiFromBase('193220441'))).toBe(true);
    expect(isValidNpi('12345')).toBe(false);
    expect(() => npiCheckDigit('12')).toThrow();
  });
});
