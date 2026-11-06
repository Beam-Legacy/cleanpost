/**
 * A minimal admin page for the mock PM (docs/05-adapters.md): what Cleanpost wrote into the PM,
 * faults to inject, and new visits to add. Protected by HTTP basic auth (PM_MOCK_ADMIN_PASSWORD).
 * Plain HTML styled with system colours; this is a stand-in for a third-party PM, not Cleanpost UI.
 */
import { and, asc, count, desc, eq, gt, inArray } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { html, raw } from 'hono/html';
import { z } from 'zod';
import type { PmDb } from './db';
import { FAULT_KINDS } from './faults';
import { createPractice, createPracticeBody, listPractices } from './create';
import { addVisits } from './load';
import {
  accounts,
  answerKey,
  charges,
  claims,
  encounters,
  patients,
  policies,
  payments,
  practices,
  remittances,
  writeLog,
  type AccountFault,
} from './schema';

export interface AdminDeps {
  db: PmDb;
  password: string;
  now: () => Date;
  /**
   * Runs the clearinghouse once (send queued claims, read 277CAs and 835s); `bill` also runs the
   * billing batch of PMs with no hold. Absent without payer-sim.
   */
  clearinghouse?: (opts?: { bill?: boolean }) => Promise<unknown>;
  /** Demo history (DEC-19): start over on the payer simulator's (past) date. */
  demoReset?: () => Promise<unknown>;
  /** Reads the payer simulator's date now, so a just-moved demo clock is never a few seconds stale. */
  refreshClock?: () => Promise<void>;
  /** Tells the payer simulator about members of a new practice (eligibility and adjudication). */
  refreshRoster?: () => Promise<unknown>;
}

const resubmitBody = z.object({
  changes: z
    .array(z.object({ lineNumber: z.number().int().min(1), modifiers: z.array(z.string().max(2)).max(4) }))
    .max(50)
    .optional(),
  originalRef: z.string().max(50).optional(),
});

const faultBody = z.object({
  kind: z.enum(FAULT_KINDS as [AccountFault['kind'], ...AccountFault['kind'][]]),
  count: z.coerce.number().int().min(1).max(1000).optional(),
  minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  endpoint: z.string().max(40).optional(),
  latencyMs: z.coerce.number().int().min(0).max(60_000).optional(),
});

const visitsBody = z.object({
  count: z.coerce.number().int().min(1).max(50).default(5),
  /** The visits' date, up to 30 days back (demo history adds a few days at a time). */
  dateOfService: z.iso.date().optional(),
  openShare: z.number().min(0).max(1).optional(),
});

const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 24px; background: Canvas; color: CanvasText; }
  table { border-collapse: collapse; margin: 8px 0 24px; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid GrayText; font-size: 14px; }
  .muted { color: GrayText; }
  form.inline { display: inline-flex; gap: 6px; align-items: center; margin: 4px 0; }
  code { font-size: 13px; }
`;

function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Mock PM</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <p class="muted">Mock PM for Cleanpost testing. Synthetic data only.</p>
        ${body}
      </body>
    </html>`;
}

/** Form posts must come from this page, not another site (basic auth is sent automatically). */
function sameOrigin(c: Context): boolean {
  const site = c.req.header('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

export function adminRoutes(deps: AdminDeps) {
  const { db } = deps;
  const app = new Hono();
  app.use('*', basicAuth({ username: 'admin', password: deps.password }));
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && !sameOrigin(c)) return c.text('Cross-site request refused', 403);
    await next();
  });

  async function setFault(accountId: string, input: z.infer<typeof faultBody>) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) return false;
    const fault: AccountFault = {
      kind: input.kind,
      ...(input.count ? { remaining: input.count } : {}),
      ...(input.minutes
        ? { until: new Date(deps.now().getTime() + input.minutes * 60_000).toISOString() }
        : {}),
      ...(input.endpoint ? { endpoints: [input.endpoint] } : {}),
      ...(input.latencyMs ? { latencyMs: input.latencyMs } : {}),
    };
    await db
      .update(accounts)
      .set({ faults: [...account.faults, fault] })
      .where(eq(accounts.id, accountId));
    return true;
  }

  // ---------- JSON API for tests and scripts ----------

  app.post('/api/clearinghouse/run', async (c) => {
    if (!deps.clearinghouse) return c.json({ error: 'payer-sim is not configured' }, 409);
    return c.json(await deps.clearinghouse({ bill: c.req.query('bill') === '1' }));
  });

  // What a biller does in the PM after a denial (Tebra has no API for it): correct the charge and
  // resubmit the claim as a corrected claim (frequency 7). Tests and demos stand in for that person.
  app.post('/api/practices/:id/encounters/:eid/resubmit', async (c) => {
    const body = resubmitBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'changes must list lineNumber and modifiers' }, 422);
    const [claim] = await db
      .select()
      .from(claims)
      .where(and(eq(claims.practiceId, c.req.param('id')), eq(claims.encounterId, c.req.param('eid'))));
    if (!claim) return c.json({ error: 'no claim for that encounter' }, 404);
    for (const ch of body.data.changes ?? []) {
      await db
        .update(charges)
        .set({ modifiers: ch.modifiers })
        .where(and(eq(charges.encounterId, claim.encounterId), eq(charges.lineNumber, ch.lineNumber)));
    }
    await db
      .update(claims)
      .set({
        status: 'queued',
        frequencyCode: '7',
        originalRef: body.data.originalRef ?? null,
        rejectionReasons: [],
        updatedAt: deps.now(),
      })
      .where(eq(claims.encounterId, claim.encounterId));
    return c.json({ ok: true, frequencyCode: '7' });
  });

  app.post('/api/accounts/:id/faults', async (c) => {
    const body = faultBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid' }, 422);
    return (await setFault(c.req.param('id'), body.data))
      ? c.json({ ok: true })
      : c.json({ error: 'not_found' }, 404);
  });

  // Demo (preview only, docs/18): break or clear the PM login behind one practice's account.
  app.post('/api/practices/:id/faults', async (c) => {
    const body = faultBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid' }, 422);
    const [p] = await db
      .select({ accountId: practices.accountId })
      .from(practices)
      .where(eq(practices.id, c.req.param('id')));
    if (!p) return c.json({ error: 'not_found' }, 404);
    return (await setFault(p.accountId, body.data))
      ? c.json({ ok: true, accountId: p.accountId })
      : c.json({ error: 'not_found' }, 404);
  });

  app.delete('/api/practices/:id/faults', async (c) => {
    const [p] = await db
      .select({ accountId: practices.accountId })
      .from(practices)
      .where(eq(practices.id, c.req.param('id')));
    if (!p) return c.json({ error: 'not_found' }, 404);
    await db.update(accounts).set({ faults: [] }).where(eq(accounts.id, p.accountId));
    return c.json({ ok: true, accountId: p.accountId });
  });

  app.delete('/api/accounts/:id/faults', async (c) => {
    await db
      .update(accounts)
      .set({ faults: [] })
      .where(eq(accounts.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  app.post('/api/practices/:id/visits', async (c) => {
    const body = visitsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid' }, 422);
    await deps.refreshClock?.();
    const now = deps.now();
    const dos = body.data.dateOfService;
    const today = now.toISOString().slice(0, 10);
    if (dos && (dos > today || Date.parse(today) - Date.parse(dos) > 30 * 86_400_000))
      return c.json({ error: 'dateOfService must be within the last 30 days' }, 422);
    const ids = await addVisits(db, {
      practiceId: c.req.param('id'),
      count: body.data.count,
      now,
      ...(dos ? { dateOfService: dos } : {}),
      ...(body.data.openShare !== undefined ? { openShare: body.data.openShare } : {}),
    });
    return c.json({ ok: true, encounters: ids });
  });

  // The ERA files a person downloads from the PM (Tebra has no ERA API), oldest first, received
  // after `after` (demo history uploads them as a biller would).
  app.get('/api/practices/:id/eras', async (c) => {
    const after = z.iso.datetime({ offset: true }).optional().safeParse(c.req.query('after'));
    if (!after.success) return c.json({ error: 'after must be a timestamp' }, 422);
    const rows = await db
      .select()
      .from(remittances)
      .where(
        and(
          eq(remittances.practiceId, c.req.param('id')),
          after.data ? gt(remittances.receivedAt, new Date(after.data)) : undefined,
        ),
      )
      .orderBy(asc(remittances.receivedAt), asc(remittances.id))
      .limit(200);
    return c.json({
      eras: rows.flatMap((e) => {
        const raw835 = (e.payload as { raw835?: string }).raw835;
        return raw835 ? [{ id: e.id, receivedAt: e.receivedAt.toISOString(), raw835 }] : [];
      }),
    });
  });

  // Onboarding demo (O-04): list practices, and create one with generated synthetic data.
  app.get('/api/practices', async (c) => c.json({ practices: await listPractices(db) }));

  app.post('/api/practices', async (c) => {
    const body = createPracticeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json({ error: 'invalid', fields: body.error.issues.map((i) => i.path.join('.')) }, 422);
    const [taken] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, body.data.accountId));
    if (taken) return c.json({ error: 'account_exists' }, 409);
    await deps.refreshClock?.();
    const created = await createPractice(db, body.data, deps.now());
    await deps.refreshRoster?.();
    return c.json({ ok: true, ...created });
  });

  // P-04 demo (DEC-31): what the patient's primary insurance card says. A card shows the plan the
  // patient really has (the answer key), which may not be the one the practice entered: the photo
  // that fixes a "member not found" claim. Synthetic data only.
  app.get('/api/practices/:id/patients/:pid/card', async (c) => {
    const [p] = await db
      .select()
      .from(patients)
      .where(and(eq(patients.practiceId, c.req.param('id')), eq(patients.id, c.req.param('pid'))));
    if (!p) return c.json({ error: 'not_found' }, 404);
    const [policy] = await db
      .select()
      .from(policies)
      .where(eq(policies.patientId, p.id))
      .orderBy(asc(policies.priority))
      .limit(1);
    if (!policy) return c.json({ error: 'no_insurance' }, 404);
    const [fact] = await db
      .select({ facts: answerKey.facts })
      .from(answerKey)
      .where(
        and(
          eq(answerKey.practiceId, p.practiceId),
          eq(answerKey.recordType, 'coverage'),
          eq(answerKey.recordId, policy.id),
        ),
      );
    const f = (fact?.facts ?? {}) as { actualPayerName?: string };
    const digits = [...policy.memberId].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 10_000, 7);
    return c.json({
      payerName: f.actualPayerName ?? policy.payerName,
      memberId: policy.memberId,
      groupNumber: policy.groupNumber,
      subscriberName: `${p.firstName} ${p.lastName}`,
      planType: ['PPO', 'HMO', 'EPO', 'POS'][digits % 4],
      rxBin: String(600_000 + digits).padStart(6, '0'),
      payerPhone: `1-800-555-${String(digits).padStart(4, '0')}`,
    });
  });

  app.post('/api/demo/reset', async (c) => {
    if (!deps.demoReset) return c.json({ error: 'demo history needs payer-sim' }, 409);
    return c.json({ ok: true, practices: await deps.demoReset() });
  });

  // ---------- HTML ----------

  app.get('/', async (c) => {
    const accts = await db.select().from(accounts).orderBy(accounts.id);
    const pracs = await db.select().from(practices).orderBy(practices.id);
    const counts = await db
      .select({ practiceId: encounters.practiceId, n: count() })
      .from(encounters)
      .groupBy(encounters.practiceId);
    const patientCounts = await db
      .select({ practiceId: patients.practiceId, n: count() })
      .from(patients)
      .groupBy(patients.practiceId);
    const n = (rows: { practiceId: string; n: number }[], id: string) =>
      rows.find((r) => r.practiceId === id)?.n ?? 0;
    return c.html(
      page(
        'Accounts',
        html`<h1>Accounts</h1>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Profile</th>
                <th>Active faults</th>
                <th>Inject a fault</th>
              </tr>
            </thead>
            <tbody>
              ${accts.map(
                (a) =>
                  html`<tr>
                    <td>${a.name} <span class="muted">(${a.id})</span></td>
                    <td>${a.profile}</td>
                    <td>
                      ${
                        a.faults.length
                          ? a.faults.map(
                              (f) => html`<code>${f.kind}${f.remaining ? ` ×${f.remaining}` : ''}</code> `,
                            )
                          : html`<span class="muted">none</span>`
                      }
                      ${
                        a.faults.length
                          ? html`<form
                              class="inline"
                              method="post"
                              action="/admin/accounts/${a.id}/faults/clear"
                            >
                              <button>Clear</button>
                            </form>`
                          : ''
                      }
                    </td>
                    <td>
                      <form class="inline" method="post" action="/admin/accounts/${a.id}/faults">
                        <select name="kind" aria-label="Fault">
                          ${FAULT_KINDS.map((k) => html`<option>${k}</option>`)}
                        </select>
                        <input
                          name="count"
                          type="number"
                          min="1"
                          value="3"
                          aria-label="Requests"
                          style="width:5em"
                        />
                        <button>Add</button>
                      </form>
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>
          <h1>Practices</h1>
          <table>
            <thead>
              <tr>
                <th>Practice</th>
                <th>Account</th>
                <th>Specialty</th>
                <th>Patients</th>
                <th>Encounters</th>
              </tr>
            </thead>
            <tbody>
              ${pracs.map(
                (p) =>
                  html`<tr>
                    <td><a href="/admin/practices/${p.id}">${p.name}</a></td>
                    <td>${p.accountId}</td>
                    <td>${p.specialty}</td>
                    <td>${n(patientCounts, p.id)}</td>
                    <td>${n(counts, p.id)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>`,
      ),
    );
  });

  app.post('/accounts/:id/faults', async (c) => {
    const form = faultBody.safeParse(Object.fromEntries(Object.entries(await c.req.parseBody())));
    if (form.success) await setFault(c.req.param('id'), form.data);
    return c.redirect('/admin');
  });

  app.post('/accounts/:id/faults/clear', async (c) => {
    await db
      .update(accounts)
      .set({ faults: [] })
      .where(eq(accounts.id, c.req.param('id')));
    return c.redirect('/admin');
  });

  app.post('/practices/:id/visits', async (c) => {
    const form = visitsBody.safeParse(Object.fromEntries(Object.entries(await c.req.parseBody())));
    await addVisits(db, {
      practiceId: c.req.param('id'),
      count: form.success ? form.data.count : 5,
      now: deps.now(),
    });
    return c.redirect(`/admin/practices/${c.req.param('id')}`);
  });

  // The ERA download a PM or clearinghouse portal offers; the file name carries no patient data.
  app.get('/eras/:id', async (c) => {
    const [e] = await db
      .select({ id: remittances.id, payload: remittances.payload })
      .from(remittances)
      .where(eq(remittances.id, c.req.param('id')));
    const raw835 = (e?.payload as { raw835?: string } | undefined)?.raw835;
    if (!e || !raw835) return c.notFound();
    return c.body(raw835, 200, {
      'content-type': 'application/edi-x12',
      'content-disposition': `attachment; filename="${e.id.replace(/[^A-Za-z0-9-]/g, '')}.835"`,
    });
  });

  app.get('/practices/:id', async (c) => {
    const [p] = await db
      .select()
      .from(practices)
      .where(eq(practices.id, c.req.param('id')));
    if (!p) return c.notFound();
    const recent = await db
      .select()
      .from(encounters)
      .where(eq(encounters.practiceId, p.id))
      .orderBy(desc(encounters.updatedAt), desc(encounters.id))
      .limit(40);
    const codes = recent.length
      ? await db
          .select({ encounterId: charges.encounterId, code: charges.code, modifiers: charges.modifiers })
          .from(charges)
          .where(
            inArray(
              charges.encounterId,
              recent.map((e) => e.id),
            ),
          )
      : [];
    const writes = await db
      .select()
      .from(writeLog)
      .where(eq(writeLog.practiceId, p.id))
      .orderBy(desc(writeLog.id))
      .limit(50);
    const pays = await db
      .select()
      .from(payments)
      .where(and(eq(payments.practiceId, p.id)))
      .orderBy(desc(payments.createdAt))
      .limit(20);
    const eras = await db
      .select({ id: remittances.id, receivedAt: remittances.receivedAt, payload: remittances.payload })
      .from(remittances)
      .where(eq(remittances.practiceId, p.id))
      .orderBy(desc(remittances.receivedAt), desc(remittances.id))
      .limit(50);
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
    return c.html(
      page(
        p.name,
        html`<p><a href="/admin">All accounts</a></p>
          <h1>${p.name}</h1>
          <form class="inline" method="post" action="/admin/practices/${p.id}/visits">
            <input
              name="count"
              type="number"
              min="1"
              max="50"
              value="5"
              aria-label="Visits"
              style="width:5em"
            />
            <button>Add today's visits</button>
          </form>
          <h2>What Cleanpost wrote</h2>
          ${
            writes.length
              ? html`<table>
                  <thead>
                    <tr>
                      <th>When (UTC)</th>
                      <th>Operation</th>
                      <th>Record</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${writes.map(
                      (w) =>
                        html`<tr>
                          <td>${fmt(w.at)}</td>
                          <td>${w.operation}</td>
                          <td><code>${w.target}</code></td>
                          <td>${w.result}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>`
              : html`<p class="muted">Nothing yet.</p>`
          }
          <h2>Payments</h2>
          ${
            pays.length
              ? html`<table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Trace</th>
                      <th>Amount</th>
                      <th>Source</th>
                      <th>Lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${pays.map(
                      (x) =>
                        html`<tr>
                          <td>${x.id}</td>
                          <td>${x.traceNumber}</td>
                          <td>$${(x.amountCents / 100).toFixed(2)}</td>
                          <td>${x.source}</td>
                          <td>${x.headerOnly ? 'Header only' : 'Posted'}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>`
              : html`<p class="muted">None.</p>`
          }
          <h2>ERA files</h2>
          <p class="muted">
            835s from the clearinghouse, auto-posted above. Where the PM has no ERA API (the Tebra profile),
            download a file here and upload it to Cleanpost.
          </p>
          ${
            eras.length
              ? html`<table>
                  <thead>
                    <tr>
                      <th>Received (UTC)</th>
                      <th>Payer</th>
                      <th>Trace</th>
                      <th>Amount</th>
                      <th>Claims</th>
                      <th>File</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${eras.map((e) => {
                      const era = e.payload as {
                        payerName: string;
                        traceNumber: string;
                        paymentAmountCents: number;
                        claims: unknown[];
                      };
                      return html`<tr>
                        <td>${fmt(e.receivedAt)}</td>
                        <td>${era.payerName}</td>
                        <td>${era.traceNumber}</td>
                        <td>$${(era.paymentAmountCents / 100).toFixed(2)}</td>
                        <td>${era.claims.length}</td>
                        <td><a href="/admin/eras/${e.id}">Download 835</a></td>
                      </tr>`;
                    })}
                  </tbody>
                </table>`
              : html`<p class="muted">None yet.</p>`
          }
          <h2>Recent encounters</h2>
          <table>
            <thead>
              <tr>
                <th>Encounter</th>
                <th>Date of service</th>
                <th>Status</th>
                <th>Codes</th>
                <th>Updated (UTC)</th>
              </tr>
            </thead>
            <tbody>
              ${recent.map(
                (e) =>
                  html`<tr>
                    <td><code>${e.id}</code></td>
                    <td>${e.dateOfService}</td>
                    <td>${e.workflowStatus ?? e.status}${e.onHold ? ' (on hold)' : ''}</td>
                    <td>
                      ${codes
                        .filter((x) => x.encounterId === e.id)
                        .map((x) => `${x.code}${x.modifiers.length ? `-${x.modifiers.join('-')}` : ''}`)
                        .join(', ')}
                    </td>
                    <td>${fmt(e.updatedAt)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>`,
      ),
    );
  });

  return app;
}
