import pg from 'pg';

/**
 * Puts the seeded e2e user back to "first sign-in": no second factor, no sessions, no lock.
 * Requires `pnpm db:migrate && pnpm seed` against DATABASE_ADMIN_URL.
 */
export const E2E_EMAIL = 'julia@northwind.test';
/** Every user the e2e specs sign in as; each is reset to first sign-in. */
export const E2E_USERS = [
  E2E_EMAIL,
  'priya@northwind.test',
  'dana@northwind.test',
  'marcus@northwind.test',
  'lena@northwind.test',
];

export default async function globalSetup() {
  const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const email of E2E_USERS) {
      const { rows } = await client.query<{ id: string }>('select id from users where email = $1', [email]);
      if (!rows[0]) throw new Error('Seed data missing: run pnpm seed first');
      const id = rows[0].id;
      await client.query('delete from two_factors where user_id = $1', [id]);
      await client.query('delete from passkeys where user_id = $1', [id]);
      await client.query('delete from sessions where user_id = $1', [id]);
      await client.query(
        "update users set two_factor_enabled = false, failed_sign_in_count = 0, locked_until = null, known_devices = '{}' where id = $1",
        [id],
      );
    }
    // The work-queue specs need claims in review: the worker (with the mock PM) syncs, builds and
    // scrubs the synthetic practices after a fresh seed. Wait for that, up to 4 minutes.
    // Then wait for it to go quiet (nothing left to build or scrub), so specs do not race it.
    const deadline = Date.now() + 300_000;
    let quiet = 0;
    for (;;) {
      const { rows } = await client.query<{ review: number; pending: number }>(
        `select (select count(*)::int from work_items where type = 'claim_review' and status <> 'resolved') as review,
                (select count(*)::int from claims where status in ('draft', 'built')) as pending`,
      );
      quiet = (rows[0]?.review ?? 0) >= 5 && rows[0]?.pending === 0 ? quiet + 1 : 0;
      if (quiet >= 3) break;
      if (Date.now() > deadline)
        throw new Error('No claims in review: start the worker and pm-mock (pnpm dev) before the e2e run');
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await client.end();
  }
}
