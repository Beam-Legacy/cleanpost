import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ForbiddenError,
  assertAllowed,
  authorize,
  clientFilter,
  type Action,
  type Actor,
  type Role,
} from '../src/policy';

const LAKESIDE = 'client-lakeside';
const CASCADE = 'client-cascade';

const actor = (role: Role, scope: 'all' | 'list' = 'list', isOwner = false): Actor => ({
  userId: 'u',
  role,
  isOwner,
  clientScope: scope,
  clientIds: scope === 'list' ? [LAKESIDE] : [],
});

const owner = actor('admin', 'all', true);
const admin = actor('admin', 'list');
const biller = actor('biller');
const viewer = actor('viewer');

const allowed = (a: Actor, action: Action) => authorize(a, action, { clientId: LAKESIDE }).allowed;

describe('S-01 role matrix', () => {
  const rows: [string, Action[], [boolean, boolean, boolean, boolean]][] = [
    ['Work items and claims: view', ['work.view', 'claim.view'], [true, true, true, true]],
    ['Work items and claims: work', ['work.resolve', 'claim.edit'], [true, true, true, false]],
    ['Release claims and post payments', ['claim.release', 'payment.post'], [true, true, true, false]],
    [
      'Clients, integrations, rules, mappings',
      ['client.create', 'client.manage', 'integration.manage', 'rules.manage', 'mappings.manage'],
      [true, true, false, false],
    ],
    [
      'Users, security, billing, audit log',
      ['users.manage', 'security.manage', 'billing.view', 'audit.view'],
      [true, true, false, false],
    ],
    ['Export patient-level data', ['phi.export'], [true, true, false, false]],
    ['Accept an 835 difference', ['remittance.accept_difference'], [true, true, false, false]],
  ];
  for (const [label, actions, expected] of rows) {
    it(label, () => {
      for (const action of actions) {
        expect(
          [owner, admin, biller, viewer].map((a) => allowed(a, action)),
          action,
        ).toEqual(expected);
      }
    });
  }

  it('lets owners and admins do everything', () => {
    for (const action of ACTIONS) expect(allowed(admin, action), action).toBe(true);
  });

  it('keeps viewers read-only and without PHI reveal', () => {
    expect(allowed(viewer, 'phi.reveal')).toBe(false);
    expect(allowed(viewer, 'reports.view')).toBe(true);
  });
});

describe('client scope', () => {
  it('limits billers and viewers to their clients', () => {
    expect(authorize(biller, 'claim.view', { clientId: CASCADE })).toEqual({
      allowed: false,
      reason: 'client_scope',
    });
    expect(authorize(viewer, 'claim.view', { clientId: CASCADE }).allowed).toBe(false);
    expect(clientFilter(biller)).toEqual([LAKESIDE]);
  });

  it('gives admins every client even with a list scope', () => {
    expect(authorize(admin, 'claim.release', { clientId: CASCADE }).allowed).toBe(true);
    expect(clientFilter(admin)).toBe('all');
  });

  it('gives all-client billers every client', () => {
    expect(authorize(actor('biller', 'all'), 'claim.view', { clientId: CASCADE }).allowed).toBe(true);
  });

  it('throws a typed error', () => {
    expect(() => assertAllowed(biller, 'users.manage')).toThrow(ForbiddenError);
  });
});
