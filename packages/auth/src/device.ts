import { createHash } from 'node:crypto';

/** "Chrome on macOS" style label from a user agent, for E-03. Never stores the raw string in emails. */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'A browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'an unknown system';
  return `${browser} on ${os}`;
}

/** Device key: browser and OS family, hashed. Coarse on purpose (no fingerprinting). */
export function deviceKey(userAgent: string | null | undefined): string {
  return createHash('sha256').update(describeDevice(userAgent)).digest('hex').slice(0, 16);
}
