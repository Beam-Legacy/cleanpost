/**
 * The billing company's own settings (DEC-34): S-14 company profile, S-12 security and S-10
 * branding. Pure: the web app validates with these, packages/auth enforces the security settings on
 * every request, and the practice report (F-01) reads the branding.
 *
 * Security floors cannot be lowered (docs/11): two-factor is always required, a session ends after
 * at most 30 idle minutes and at most 12 hours in all. A stored value outside the floors (an old
 * row, a hand edit) never loosens them: it reads as the default.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- S-14 company profile

export const US_TIME_ZONES = [
  { id: 'America/New_York', label: 'Eastern Time' },
  { id: 'America/Chicago', label: 'Central Time' },
  { id: 'America/Denver', label: 'Mountain Time' },
  { id: 'America/Phoenix', label: 'Arizona Time (no daylight saving)' },
  { id: 'America/Los_Angeles', label: 'Pacific Time' },
  { id: 'America/Anchorage', label: 'Alaska Time' },
  { id: 'Pacific/Honolulu', label: 'Hawaii Time' },
] as const;
export type TimeZoneId = (typeof US_TIME_ZONES)[number]['id'];
const TIME_ZONE_IDS = US_TIME_ZONES.map((t) => t.id) as [TimeZoneId, ...TimeZoneId[]];

export interface Contact {
  name: string;
  email: string;
}

const contactSchema = z.object({
  name: z.string().trim().min(1, 'Add a name.').max(120),
  email: z.email('Enter an email address.').max(254),
});

/** A US or international number: 10 to 15 digits once spaces, dots, dashes and brackets are gone. */
export function phoneOk(phone: string): boolean {
  const digits = phone.replace(/[\s().+-]/g, '');
  return phone.trim() === '' || /^\d{10,15}$/.test(digits);
}

export const profileSchema = z.object({
  legalName: z.string().trim().min(1, 'Add the legal name.').max(200),
  name: z.string().trim().min(1, 'Add the name people know you by.').max(80),
  address: z.string().trim().max(300),
  phone: z.string().trim().max(40).refine(phoneOk, 'Enter a phone number with area code.'),
  timezone: z.enum(TIME_ZONE_IDS),
  /** Receives breach and incident notices under the BAA: required (S-14 rules). */
  securityContact: contactSchema,
  billingContact: contactSchema.nullable(),
});
export type Profile = z.infer<typeof profileSchema>;
export type ProfileInput = z.input<typeof profileSchema>;

/** A contact stored in tenants.security_contact or billing_contact, or null when unusable. */
export function readContact(raw: unknown): Contact | null {
  const parsed = contactSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** tenants.address holds `{ line }`: one line, as the company writes it. */
export function readAddress(raw: unknown): string {
  const line = (raw as { line?: unknown } | null)?.line;
  return typeof line === 'string' ? line : '';
}

// ---------------------------------------------------------------- S-12 security

export const IDLE_MINUTES = [15, 30] as const;
export const ABSOLUTE_HOURS = [4, 8, 12] as const;
export const PATIENT_EXPORTS = ['admins', 'owner', 'nobody'] as const;
export type PatientExports = (typeof PATIENT_EXPORTS)[number];

/** How long a trusted device skips the second step (S-12, A-02). */
export const TRUSTED_DEVICE_HOURS = 12;
/** Saving S-12 needs a second factor entered this recently (step-up). */
export const STEP_UP_MINUTES = 10;

export interface SecuritySettings {
  /** Passkey sign-in is accepted by this company. */
  allowPasskeys: boolean;
  /** A sign-in that skipped the second step on a trusted device is accepted by this company. */
  trustedDevices: boolean;
  idleMinutes: (typeof IDLE_MINUTES)[number];
  absoluteHours: (typeof ABSOLUTE_HOURS)[number];
  /** Addresses or ranges (CIDR) sign-in is allowed from; empty means anywhere. */
  ipAllowlist: string[];
  /** Who may export patient-level data (names or IDs). */
  patientExports: PatientExports;
}

export const SECURITY_DEFAULTS: SecuritySettings = {
  allowPasskeys: true,
  trustedDevices: false,
  idleMinutes: 15,
  absoluteHours: 12,
  ipAllowlist: [],
  patientExports: 'admins',
};

export const securitySchema = z.object({
  allowPasskeys: z.boolean(),
  trustedDevices: z.boolean(),
  idleMinutes: z.union([z.literal(15), z.literal(30)]),
  absoluteHours: z.union([z.literal(4), z.literal(8), z.literal(12)]),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50),
  patientExports: z.enum(PATIENT_EXPORTS),
});

/** The company's security settings from tenants.settings, defaults filled and floors kept. */
export function securitySettings(settings: unknown): SecuritySettings {
  const raw = ((settings ?? {}) as { security?: Record<string, unknown> }).security ?? {};
  const pick = <K extends keyof SecuritySettings>(
    key: K,
    ok: (v: unknown) => boolean,
  ): SecuritySettings[K] => (ok(raw[key]) ? (raw[key] as SecuritySettings[K]) : SECURITY_DEFAULTS[key]);
  return {
    allowPasskeys: pick('allowPasskeys', (v) => typeof v === 'boolean'),
    trustedDevices: pick('trustedDevices', (v) => typeof v === 'boolean'),
    idleMinutes: pick('idleMinutes', (v) => (IDLE_MINUTES as readonly unknown[]).includes(v)),
    absoluteHours: pick('absoluteHours', (v) => (ABSOLUTE_HOURS as readonly unknown[]).includes(v)),
    ipAllowlist: pick(
      'ipAllowlist',
      (v) => Array.isArray(v) && v.every((e) => typeof e === 'string' && parseIpRange(e) !== null),
    ),
    patientExports: pick('patientExports', (v) => (PATIENT_EXPORTS as readonly unknown[]).includes(v)),
  };
}

/** S-12 Exports: may this person export patient-level data? */
export function canExportPatientData(
  actor: { role: string; isOwner: boolean },
  who: PatientExports,
): boolean {
  if (who === 'nobody') return false;
  if (who === 'owner') return actor.isOwner;
  return actor.role === 'admin';
}

// ---------------------------------------------------------------- IP allowlist

export interface IpRange {
  version: 4 | 6;
  /** The network address, host bits cleared. */
  base: bigint;
  bits: number;
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255 || (p.length > 1 && p.startsWith('0'))) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseIpv6(text: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.split('::').length > 2) return null;
  let tail = text;
  let v4: bigint | null = null;
  // An IPv4 address in the last 32 bits (::ffff:192.0.2.1).
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = `${text.slice(0, lastColon + 1)}0:0`;
    if (tail.endsWith(':::0:0')) return null;
  }
  const [head, rest] = tail.split('::') as [string, string | undefined];
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right];
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (v4 !== null) n = (n & ~0xffffffffn) | v4;
  return n;
}

/** One address or CIDR range, IPv4 or IPv6 (an IPv4-mapped IPv6 address reads as IPv4). */
export function parseIpRange(input: string): IpRange | null {
  const text = input.trim();
  const [addr, prefix, extra] = text.split('/');
  if (!addr || extra !== undefined) return null;
  let version: 4 | 6;
  let n = parseIpv4(addr);
  if (n !== null) version = 4;
  else {
    n = addr.includes(':') ? parseIpv6(addr) : null;
    if (n === null) return null;
    version = 6;
    if (n >> 32n === 0xffffn && prefix === undefined) {
      version = 4;
      n = n & 0xffffffffn;
    }
  }
  const max = version === 4 ? 32 : 128;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return null;
  const bits = prefix === undefined ? max : Number(prefix);
  if (bits > max || (prefix !== undefined && bits < (version === 4 ? 8 : 16))) return null;
  const hostBits = BigInt(max - bits);
  return { version, base: (n >> hostBits) << hostBits, bits };
}

/** S-12's text box: one address or range per line; blank lines and spaces ignored. */
export function parseAllowlist(
  text: string,
): { ok: true; entries: string[] } | { ok: false; line: number; text: string } {
  const entries: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (!parseIpRange(line)) return { ok: false, line: i + 1, text: line.slice(0, 64) };
    if (!entries.includes(line)) entries.push(line);
  }
  return { ok: true, entries };
}

/** Is this address in the allowlist? Everyone is, when it is empty; an unknown address never is. */
export function ipAllowed(ip: string | null | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  const addr = parseIpRange(ip.replace(/^\[|\]$/g, ''));
  if (!addr || addr.bits !== (addr.version === 4 ? 32 : 128)) return false;
  return allowlist.some((entry) => {
    const r = parseIpRange(entry);
    if (!r || r.version !== addr.version) return false;
    const hostBits = BigInt((r.version === 4 ? 32 : 128) - r.bits);
    return addr.base >> hostBits === r.base >> hostBits;
  });
}

// ---------------------------------------------------------------- S-10 branding

export const LOGO_MIN_WIDTH = 200;
export const LOGO_MAX_BYTES = 1_000_000;
export const LOGO_TYPES = ['image/png', 'image/svg+xml'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export interface BrandingLogo {
  /** Where the bytes are (packages/documents store). */
  storageKey: string;
  contentType: LogoType;
  /** Pixels for a PNG; null for an SVG, which scales. */
  width: number | null;
  height: number | null;
}

export interface Branding {
  /** The name on reports; the company's display name when empty. */
  reportName: string | null;
  contactLine: string | null;
  footerNote: string | null;
  /** "Prepared with Cleanpost" in the footer: off unless the company turns it on (S-10 rules). */
  showCredit: boolean;
  logo: BrandingLogo | null;
}

export const BRANDING_DEFAULTS: Branding = {
  reportName: null,
  contactLine: null,
  footerNote: null,
  showCredit: false,
  logo: null,
};

export const brandingInputSchema = z.object({
  reportName: z.string().trim().max(80),
  contactLine: z.string().trim().max(160),
  footerNote: z.string().trim().max(300),
  showCredit: z.boolean(),
});
export type BrandingInput = z.input<typeof brandingInputSchema>;

const logoSchema = z.object({
  storageKey: z.string().min(1).max(200),
  contentType: z.enum(LOGO_TYPES),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

/** The company's branding from tenants.settings, defaults filled. */
export function branding(settings: unknown): Branding {
  const raw = ((settings ?? {}) as { branding?: Record<string, unknown> }).branding ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const logo = logoSchema.safeParse(raw.logo);
  return {
    reportName: text(raw.reportName),
    contactLine: text(raw.contactLine),
    footerNote: text(raw.footerNote),
    showCredit: raw.showCredit === true,
    logo: logo.success ? logo.data : null,
  };
}

/** Up to two initials for the placeholder mark when there is no logo. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

/** What a client report shows (F-01, the S-10 preview). */
export function reportBrand(companyName: string, b: Branding) {
  const name = b.reportName ?? companyName;
  return {
    name,
    initials: initials(name),
    hasLogo: b.logo !== null,
    contactLine: b.contactLine,
    footerNote: b.footerNote,
    credit: b.showCredit,
  };
}

/** PNG width and height from the IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * An SVG fit to show as a logo: an <svg> root and nothing that runs (scripts, event handlers,
 * foreign content or links out). It is served with a sandboxing policy as well.
 */
export function svgSafe(text: string): boolean {
  if (!/<svg[\s>]/i.test(text)) return false;
  // Scripts, handlers, embedded documents, and anything fetched from elsewhere (links, CSS url()
  // and @import, protocol-relative included).
  return !/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object|href\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import/i.test(
    text,
  );
}

export type LogoCheck =
  | { ok: true; contentType: LogoType; width: number | null; height: number | null }
  | { ok: false; message: string };

/** S-10: PNG or SVG, at most 1 MB, a PNG at least 200 px wide ("Logo too small" names the size). */
export function checkLogo(contentType: string, bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return { ok: false, message: 'That file is empty.' };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, message: 'Use a logo under 1 MB.' };
  if (contentType === 'image/png') {
    const size = pngSize(bytes);
    if (!size) return { ok: false, message: 'That file is not a PNG image.' };
    if (size.width < LOGO_MIN_WIDTH)
      return {
        ok: false,
        message: `The logo is ${size.width} px wide. Use one at least ${LOGO_MIN_WIDTH} px wide.`,
      };
    return { ok: true, contentType, ...size };
  }
  if (contentType === 'image/svg+xml') {
    if (!svgSafe(new TextDecoder().decode(bytes)))
      return { ok: false, message: 'That SVG has scripts or links in it. Export a plain SVG or a PNG.' };
    return { ok: true, contentType, width: null, height: null };
  }
  return { ok: false, message: 'Use a PNG or SVG file.' };
}
