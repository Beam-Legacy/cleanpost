import { describe, expect, it } from 'vitest';
import { company } from '../src';

describe('S-12 security settings', () => {
  it('fills defaults and never loosens the floors from a stored value', () => {
    expect(company.securitySettings({})).toEqual(company.SECURITY_DEFAULTS);
    expect(company.securitySettings(null)).toEqual(company.SECURITY_DEFAULTS);
    const loose = company.securitySettings({
      security: { idleMinutes: 120, absoluteHours: 24, allowPasskeys: 'yes', ipAllowlist: ['nope'] },
    });
    expect(loose).toMatchObject({ idleMinutes: 15, absoluteHours: 12, allowPasskeys: true, ipAllowlist: [] });
    expect(
      company.securitySettings({
        security: { idleMinutes: 30, absoluteHours: 8, trustedDevices: true, patientExports: 'owner' },
      }),
    ).toMatchObject({ idleMinutes: 30, absoluteHours: 8, trustedDevices: true, patientExports: 'owner' });
  });

  it('lets the chosen people export patient-level data', () => {
    const owner = { role: 'admin', isOwner: true };
    const admin = { role: 'admin', isOwner: false };
    const biller = { role: 'biller', isOwner: false };
    expect([owner, admin, biller].map((a) => company.canExportPatientData(a, 'admins'))).toEqual([
      true,
      true,
      false,
    ]);
    expect([owner, admin].map((a) => company.canExportPatientData(a, 'owner'))).toEqual([true, false]);
    expect(company.canExportPatientData(owner, 'nobody')).toBe(false);
  });
});

describe('IP allowlist', () => {
  it('reads IPv4 and IPv6 addresses and ranges, and refuses what is not one', () => {
    expect(company.parseIpRange('203.0.113.7')).toMatchObject({ version: 4, bits: 32 });
    expect(company.parseIpRange('203.0.113.0/24')).toMatchObject({ version: 4, bits: 24 });
    expect(company.parseIpRange('2001:db8::/32')).toMatchObject({ version: 6, bits: 32 });
    expect(company.parseIpRange('::ffff:198.51.100.24')).toMatchObject({ version: 4, bits: 32 });
    for (const bad of [
      '',
      '256.1.1.1',
      '1.2.3',
      '01.2.3.4',
      '1.2.3.4/33',
      '0.0.0.0/0',
      '::/0',
      '2001:db8::1::2',
      'host.example',
      '1.2.3.4/24/1',
    ])
      expect(company.parseIpRange(bad), bad).toBeNull();
  });

  it('parses the text box line by line and names the first bad line', () => {
    expect(company.parseAllowlist('  203.0.113.0/24 \n\n198.51.100.24\n198.51.100.24')).toEqual({
      ok: true,
      entries: ['203.0.113.0/24', '198.51.100.24'],
    });
    expect(company.parseAllowlist('203.0.113.0/24\nfoo')).toEqual({ ok: false, line: 2, text: 'foo' });
    expect(company.parseAllowlist('')).toEqual({ ok: true, entries: [] });
  });

  it('matches addresses against the ranges; empty means anywhere, unknown means nowhere', () => {
    const list = ['203.0.113.0/24', '198.51.100.24', '2001:db8:abcd::/48'];
    expect(company.ipAllowed('203.0.113.200', list)).toBe(true);
    expect(company.ipAllowed('203.0.114.1', list)).toBe(false);
    expect(company.ipAllowed('198.51.100.24', list)).toBe(true);
    expect(company.ipAllowed('::ffff:198.51.100.24', list)).toBe(true);
    expect(company.ipAllowed('2001:db8:abcd:12::5', list)).toBe(true);
    expect(company.ipAllowed('2001:db8:abce::5', list)).toBe(false);
    expect(company.ipAllowed(null, list)).toBe(false);
    expect(company.ipAllowed('not an ip', list)).toBe(false);
    expect(company.ipAllowed(null, [])).toBe(true);
    expect(company.ipAllowed('203.0.114.1', [])).toBe(true);
  });
});

describe('S-14 company profile', () => {
  const valid = {
    legalName: 'Northwind Billing Services LLC',
    name: 'Northwind Billing',
    address: '215 SW 4th Ave, Suite 300, Corvallis, OR 97333',
    phone: '(541) 555-0142',
    timezone: 'America/Los_Angeles',
    securityContact: { name: 'Priya Shah', email: 'priya@northwind.test' },
    billingContact: null,
  };

  it('requires the security contact and checks the phone and time zone', () => {
    expect(company.profileSchema.safeParse(valid).success).toBe(true);
    expect(
      company.profileSchema.safeParse({ ...valid, securityContact: { name: '', email: 'x' } }).success,
    ).toBe(false);
    expect(company.profileSchema.safeParse({ ...valid, phone: '555-0142' }).success).toBe(false);
    expect(company.profileSchema.safeParse({ ...valid, phone: '' }).success).toBe(true);
    expect(company.profileSchema.safeParse({ ...valid, timezone: 'Europe/Paris' }).success).toBe(false);
  });

  it('reads stored contacts and the address line', () => {
    expect(company.readContact({ name: 'Priya Shah', email: 'priya@northwind.test' })).toEqual({
      name: 'Priya Shah',
      email: 'priya@northwind.test',
    });
    expect(company.readContact({ name: 'x' })).toBeNull();
    expect(company.readAddress({ line: '215 SW 4th Ave' })).toBe('215 SW 4th Ave');
    expect(company.readAddress(null)).toBe('');
  });
});

describe('S-10 branding', () => {
  const png = (width: number, height: number) => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, width);
    new DataView(b.buffer).setUint32(20, height);
    return b;
  };
  const text = (s: string) => new TextEncoder().encode(s);

  it('fills defaults: the company name, no logo, no Cleanpost credit', () => {
    const b = company.branding({});
    expect(b).toEqual(company.BRANDING_DEFAULTS);
    expect(company.reportBrand('Northwind Billing', b)).toMatchObject({
      name: 'Northwind Billing',
      initials: 'NB',
      hasLogo: false,
      credit: false,
    });
    const set = company.branding({
      branding: { reportName: ' Northwind ', contactLine: 'billing@northwind.test', showCredit: true },
    });
    expect(company.reportBrand('Northwind Billing', set)).toMatchObject({
      name: 'Northwind',
      initials: 'N',
      contactLine: 'billing@northwind.test',
      credit: true,
    });
  });

  it('takes a PNG at least 200 px wide or a plain SVG, and says why not otherwise', () => {
    expect(company.checkLogo('image/png', png(400, 120))).toEqual({
      ok: true,
      contentType: 'image/png',
      width: 400,
      height: 120,
    });
    expect(company.checkLogo('image/png', png(120, 40))).toEqual({
      ok: false,
      message: 'The logo is 120 px wide. Use one at least 200 px wide.',
    });
    expect(company.checkLogo('image/png', text('GIF89a not a png at all......'))).toMatchObject({
      ok: false,
    });
    expect(company.checkLogo('image/jpeg', png(400, 120))).toEqual({
      ok: false,
      message: 'Use a PNG or SVG file.',
    });
    expect(
      company.checkLogo(
        'image/svg+xml',
        text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'),
      ),
    ).toMatchObject({ ok: true, width: null });
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="https://example.com"><rect/></a></svg>',
      '<svg><foreignObject></foreignObject></svg>',
      '<svg><image href="//tracker.example/p.png"/></svg>',
      '<svg><style>rect { fill: url(https://example.com/x.svg#g) }</style></svg>',
      '<svg><style>@import "https://example.com/f.css";</style></svg>',
      '<html>no svg</html>',
    ])
      expect(company.checkLogo('image/svg+xml', text(bad)).ok, bad).toBe(false);
    expect(company.checkLogo('image/png', new Uint8Array(company.LOGO_MAX_BYTES + 1))).toEqual({
      ok: false,
      message: 'Use a logo under 1 MB.',
    });
  });

  it('makes initials from the first two words', () => {
    expect(company.initials('Northwind Billing Services')).toBe('NB');
    expect(company.initials('harbor-rcm')).toBe('HR');
    expect(company.initials('  ')).toBe('?');
  });
});
