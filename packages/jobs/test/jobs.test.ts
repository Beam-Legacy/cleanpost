import { describe, expect, it } from 'vitest';
import { demoWorkdayPayload, JOBS, QUEUES, syncPullPayload, waitForQueues, type PgBoss } from '../src';

describe('job payloads', () => {
  it('carry IDs only', () => {
    const ok = {
      tenantId: '01a00000-0000-7000-8000-000000000001',
      connectionId: '01a00000-0000-7000-8000-0000000000c1',
      trigger: 'manual',
    };
    expect(syncPullPayload.parse(ok)).toEqual(ok);
    expect(syncPullPayload.safeParse({ ...ok, connectionId: 'Lakeside' }).success).toBe(false);
    // Unknown keys are dropped, so nothing else rides along in a payload.
    expect(syncPullPayload.parse({ ...ok, patientName: 'x' })).not.toHaveProperty('patientName');
  });

  it('carry only the days the Demo clock moved for the simulated workday', () => {
    expect(demoWorkdayPayload.parse({ days: 7, note: 'x' })).toEqual({ days: 7 });
    for (const days of [0, 31, 1.5]) expect(demoWorkdayPayload.safeParse({ days }).success).toBe(false);
    expect(QUEUES.find((q) => q.name === JOBS.demoWorkday)?.options).toMatchObject({ policy: 'singleton' });
  });
});

describe('queues', () => {
  it('retry sync.pull 5 times with backoff, then dead-letter it (docs/01-architecture.md)', () => {
    const pull = QUEUES.find((q) => q.name === JOBS.syncPull)!;
    expect(pull.options).toMatchObject({
      retryLimit: 4,
      retryBackoff: true,
      deadLetter: JOBS.deadLetter,
      policy: 'stately',
    });
    expect(QUEUES.map((q) => q.name)).toContain(JOBS.deadLetter);
  });
});

describe('waitForQueues', () => {
  it('waits until the release step has made every queue, saying which are missing', async () => {
    const names = QUEUES.map((q) => q.name);
    let calls = 0;
    const boss = {
      getQueues: async () => {
        calls++;
        return (calls < 3 ? names.filter((n) => n !== JOBS.notifySweep) : names).map((name) => ({ name }));
      },
    } as unknown as PgBoss;
    const waits: string[][] = [];
    await waitForQueues(boss, { intervalMs: 1, onWait: (m) => waits.push(m) });
    expect(calls).toBe(3);
    expect(waits).toEqual([[JOBS.notifySweep], [JOBS.notifySweep]]);
  });

  it('stops waiting when the worker is stopping', async () => {
    const boss = { getQueues: async () => [] } as unknown as PgBoss;
    await expect(waitForQueues(boss, { intervalMs: 1, signal: () => true })).resolves.toBeUndefined();
  });
});
