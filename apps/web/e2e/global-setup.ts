import pg from 'pg';

/**
 * Puts the seeded e2e user back to "first sign-in": no second factor, no sessions, no lock.
 * Requires `pnpm db:migrate && pnpm seed` against DATABASE_ADMIN_URL.
 */
export const E2E_EMAIL = 'julia@northwind.test';

export default async function globalSetup() {
  const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>('select id from users where email = $1', [E2E_EMAIL]);
    if (!rows[0]) throw new Error('Seed data missing: run pnpm seed first');
    const id = rows[0].id;
    await client.query('delete from two_factors where user_id = $1', [id]);
    await client.query('delete from passkeys where user_id = $1', [id]);
    await client.query('delete from sessions where user_id = $1', [id]);
    await client.query(
      "update users set two_factor_enabled = false, failed_sign_in_count = 0, locked_until = null, known_devices = '{}' where id = $1",
      [id],
    );
  } finally {
    await client.end();
  }
}
