import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, FieldCryptoError, last4 } from '../src/crypto';

const env = { FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') };

describe('field encryption', () => {
  it('round-trips and never repeats ciphertext', () => {
    const a = encryptField('XQ00000042', env);
    const b = encryptField('XQ00000042', env);
    expect(a).not.toBe(b);
    expect(a).not.toContain('XQ00000042');
    expect(decryptField(a, env)).toBe('XQ00000042');
    expect(last4('XQ00000042')).toBe('0042');
  });

  it('detects tampering and the wrong key', () => {
    const stored = encryptField('93-1234567', env);
    const parts = stored.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptField(parts.join(':'), env)).toThrow();
    expect(() =>
      decryptField(stored, { FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
    ).toThrow();
  });

  it('rejects unknown formats and short keys', () => {
    expect(() => decryptField('plain', env)).toThrow(FieldCryptoError);
    expect(() =>
      encryptField('x', {
        FIELD_ENCRYPTION_KEY: randomBytes(16).toString('base64') + 'AAAAAAAAAAAAAAAAAAAA',
      }),
    ).toThrow();
  });
});
