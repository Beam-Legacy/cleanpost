import 'server-only';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { approvalLimitCents } from '@cleanpost/claims';
import { adjustmentMappings, connections, users, writeOffRequests, type Tx } from '@cleanpost/db';

/** D-03: what the write-off dialog offers for a client. */
export interface WriteOffOptions {
  pmName: string;
  /** The client's PM write-off codes (adjustment mappings with action write_off). */
  pmCodes: string[];
  /** A biller writes off up to this alone; above it an admin approves. */
  limitCents: number;
}

export interface WriteOffRequestView {
  id: string;
  status: string;
  amountCents: number;
  reason: string;
  note: string | null;
  pmCode: string;
  requestedByName: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}

export async function writeOffOptions(tx: Tx, tenantId: string, clientId: string): Promise<WriteOffOptions> {
  const [conn] = await tx
    .select({ adapterKey: connections.adapterKey, settings: connections.settings })
    .from(connections)
    .where(eq(connections.clientId, clientId))
    .limit(1);
  const rows = await tx
    .selectDistinct({ code: adjustmentMappings.pmAdjustmentCode })
    .from(adjustmentMappings)
    .where(
      and(
        eq(adjustmentMappings.action, 'write_off'),
        or(
          eq(adjustmentMappings.clientId, clientId),
          conn
            ? and(isNull(adjustmentMappings.clientId), eq(adjustmentMappings.pmType, conn.adapterKey))
            : undefined,
        ),
      ),
    );
  return {
    pmName: ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
    pmCodes: [...new Set(rows.map((r) => r.code.toUpperCase()))].sort(),
    limitCents: await approvalLimitCents(tx, tenantId),
  };
}

const requestColumns = {
  id: writeOffRequests.id,
  status: writeOffRequests.status,
  amountCents: writeOffRequests.amountCents,
  reason: writeOffRequests.reason,
  note: writeOffRequests.note,
  pmCode: writeOffRequests.pmCode,
  requestedByName: users.name,
  createdAt: writeOffRequests.createdAt,
  decidedAt: writeOffRequests.decidedAt,
  decisionNote: writeOffRequests.decisionNote,
};

/** A write-off on the claim still waiting for an admin (D-02, W-16 show it instead of Write off). */
export async function pendingWriteOff(tx: Tx, claimId: string): Promise<WriteOffRequestView | null> {
  const [r] = await tx
    .select(requestColumns)
    .from(writeOffRequests)
    .leftJoin(users, eq(users.id, writeOffRequests.requestedBy))
    .where(and(eq(writeOffRequests.claimId, claimId), eq(writeOffRequests.status, 'pending')))
    .limit(1);
  return r ?? null;
}

/** The request an approval item carries (W-01 panel for write_off_approval). */
export async function requestOfApproval(tx: Tx, approvalItemId: string): Promise<WriteOffRequestView | null> {
  const [r] = await tx
    .select(requestColumns)
    .from(writeOffRequests)
    .leftJoin(users, eq(users.id, writeOffRequests.requestedBy))
    .where(eq(writeOffRequests.approvalItemId, approvalItemId))
    .orderBy(desc(writeOffRequests.createdAt))
    .limit(1);
  return r ?? null;
}
