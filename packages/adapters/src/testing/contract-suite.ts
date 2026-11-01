/**
 * Adapter contract suite (docs/05-adapters.md). Every registered adapter must pass it:
 * capabilities for every operation; pulls paginate, are idempotent and produce valid records;
 * operations it cannot do return UNSUPPORTED with a manual task; outputs carry no PHI.
 */
import { scanForPhi } from '@cleanpost/testing';
import { describe, expect, it } from 'vitest';
import type { Connection, OpResult, PmAdapter } from '../contract';
import { OPERATIONS } from '../profiles';
import { PULL_OPERATIONS, PULL_SCHEMAS, type PullOperation } from '../schemas';

export interface ContractSetup {
  adapter: PmAdapter;
  conn: Connection;
  since: Date;
  /** External IDs that action operations act on, from the adapter's own data. */
  sampleEncounterId: string;
}

const ACTIONS = [
  'holdCharge',
  'releaseCharge',
  'markChargeBilled',
  'pushChargeCorrection',
  'postPayment',
] as const;

async function pullAll(adapter: PmAdapter, conn: Connection, op: PullOperation, since: Date) {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await adapter[op](conn, since, cursor);
    items.push(...res.items);
    if (!res.nextCursor) return items;
    cursor = res.nextCursor;
  }
  throw new Error(`${op} did not finish paging`);
}

function runAction(
  adapter: PmAdapter,
  conn: Connection,
  op: (typeof ACTIONS)[number],
  encounterId: string,
): Promise<OpResult> {
  switch (op) {
    case 'holdCharge':
      return adapter.holdCharge(conn, encounterId);
    case 'releaseCharge':
      return adapter.releaseCharge(conn, encounterId);
    case 'markChargeBilled':
      return adapter.markChargeBilled(conn, encounterId, 'PCN-CONTRACT-1');
    case 'pushChargeCorrection':
      return adapter.pushChargeCorrection(conn, {
        encounterExternalId: encounterId,
        changes: [{ field: 'lines[0].modifiers', from: [], to: ['25'], reason: 'Contract test' }],
      });
    case 'postPayment':
      return adapter.postPayment(conn, {
        remittanceId: '01a00000-0000-7000-8000-00000000c0de',
        traceNumber: 'CONTRACT-1',
        paymentDate: '2026-10-21',
        paymentAmountCents: 0,
        allocations: [],
      });
  }
}

export function adapterContract(name: string, setup: () => Promise<ContractSetup>) {
  describe(`adapter contract: ${name}`, () => {
    it('declares a capability for every operation', async () => {
      const { adapter, conn } = await setup();
      const caps = await adapter.capabilities(conn);
      for (const op of OPERATIONS) {
        expect([0, 1, 2, 3, 4, 'unavailable'], op).toContain(caps[op]);
      }
      // docs/05-adapters.md: only these three may be 'unavailable'; everything else falls back to manual.
      const mayBeUnavailable = new Set(['holdCharge', 'releaseCharge', 'markChargeBilled']);
      for (const op of OPERATIONS.filter((o) => !mayBeUnavailable.has(o))) {
        expect(caps[op], `${op} must fall back to manual, not 'unavailable'`).not.toBe('unavailable');
      }
    });

    for (const op of PULL_OPERATIONS) {
      it(`${op}: pages to the end, validates, has no duplicates and is idempotent`, async () => {
        const { adapter, conn, since } = await setup();
        const first = await pullAll(adapter, conn, op, since);
        for (const item of first) {
          const res = PULL_SCHEMAS[op].safeParse(item);
          expect(res.success, res.success ? '' : JSON.stringify(res.error.issues[0]?.path)).toBe(true);
        }
        const key = (i: unknown) => {
          const o = i as Record<string, string>;
          return op === 'pullPostings'
            ? `${o.encounterExternalId}:${o.lineExternalId}:${o.traceNumber}`
            : (o.externalId ?? o.encounterExternalId);
        };
        const keys = first.map(key);
        expect(new Set(keys).size, 'duplicate records across pages').toBe(keys.length);
        const second = await pullAll(adapter, conn, op, since);
        expect(second.map(key)).toEqual(keys);
      });
    }

    it('returns a manual task for every action it cannot do, and typed results otherwise', async () => {
      const { adapter, conn, sampleEncounterId } = await setup();
      const caps = await adapter.capabilities(conn);
      for (const op of ACTIONS) {
        const res = await runAction(adapter, conn, op, sampleEncounterId);
        if (caps[op] === 0 || caps[op] === 'unavailable') {
          expect(res.ok, op).toBe(false);
          if (!res.ok) {
            expect(res.code, op).toBe('UNSUPPORTED');
            expect(res.manualTask?.operation, op).toBe(op);
            expect(res.manualTask?.instructions.length, op).toBeGreaterThan(0);
          }
        } else if (!res.ok) {
          expect(
            [
              'UNSUPPORTED',
              'AUTH_FAILED',
              'RATE_LIMITED',
              'NOT_FOUND',
              'VALIDATION',
              'CONFLICT',
              'UPSTREAM_ERROR',
              'TIMEOUT',
            ],
            op,
          ).toContain(res.code);
        }
        expect(scanForPhi(JSON.stringify(res)), `${op} result carries PHI`).toEqual([]);
      }
    });

    it('answers a health check', async () => {
      const { adapter, conn } = await setup();
      const health = await adapter.healthCheck(conn);
      expect(typeof health.ok).toBe('boolean');
      expect(health.checkedAt).toBeInstanceOf(Date);
    });
  });
}
