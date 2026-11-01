'use server';
import { cookies } from 'next/headers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { userPreferences, withTenant } from '@cleanpost/db';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const Prefs = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  density: z.enum(['compact', 'comfortable']).optional(),
});

/** G-05: preferences save immediately per user (DB) and in a cookie so the first paint matches. */
export async function savePreferences(input: z.input<typeof Prefs>) {
  const prefs = Prefs.parse(input);
  const ctx = await requireActiveContext();
  const jar = await cookies();
  const year = 60 * 60 * 24 * 365;
  if (prefs.theme)
    jar.set('cp-theme', prefs.theme, {
      maxAge: year,
      sameSite: 'lax',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
  if (prefs.density)
    jar.set('cp-density', prefs.density, {
      maxAge: year,
      sameSite: 'lax',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .insert(userPreferences)
      .values({ tenantId: ctx.tenantId, userId: ctx.user.id, ...prefs })
      .onConflictDoUpdate({
        target: [userPreferences.tenantId, userPreferences.userId],
        set: { ...prefs, updatedAt: sql`now()` },
      }),
  );
}
