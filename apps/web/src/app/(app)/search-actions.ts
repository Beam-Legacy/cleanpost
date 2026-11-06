'use server';
/**
 * G-03: record search and recent records for the signed-in person (packages/search). Client scope,
 * role and the audit log are applied there; the query text is never logged.
 */
import { z } from 'zod';
import { todayPacific } from '@cleanpost/reports';
import { recentRecords, searchRecords, type RecentRecord, type SearchResults } from '@cleanpost/search';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export async function searchAction(query: string): Promise<SearchResults> {
  const ctx = await requireActiveContext();
  const q = z.string().max(120).parse(query);
  return searchRecords(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, actor: ctx.actor },
    q,
    todayPacific(),
  );
}

export async function recentAction(): Promise<RecentRecord[]> {
  const ctx = await requireActiveContext();
  return recentRecords(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, actor: ctx.actor });
}
