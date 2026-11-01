import { sql } from 'drizzle-orm';
import { isRedactedKey } from '@cleanpost/log';
import type { Tx } from './client';
import { auditEvents } from './schema';

/** `user:<id>`, `automation:<rule>`, `operator:<id>` or `system` (CLAUDE.md rule 8). */
export type AuditActor = `user:${string}` | `automation:${string}` | `operator:${string}` | 'system';

export interface AuditEvent {
  actor: AuditActor;
  /** Past-tense verb phrase, e.g. `patient.viewed`, `claim.released`, `phi.revealed`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  clientId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** IDs, counts and field names only; never PHI values. Checked on write. */
  metadata?: Record<string, unknown>;
}

export class AuditEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditEventError';
  }
}

const ACTOR_RE = /^(?:(?:user|automation|operator):[\w.:-]+|system)$/;
const ACTION_RE = /^[a-z_]+(?:\.[a-z_]+)+$/;

function findRedactedKey(value: unknown, path: string[] = []): string | null {
  if (value === null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (isRedactedKey(k)) return [...path, k].join('.');
    const nested = findRedactedKey(v, [...path, k]);
    if (nested) return nested;
  }
  return null;
}

/**
 * Appends one audit event inside the caller's tenant transaction. The tenant comes from the
 * transaction context, never from the caller, so an event cannot be written to another tenant.
 */
export async function recordAudit(tx: Tx, event: AuditEvent): Promise<void> {
  if (!ACTOR_RE.test(event.actor)) throw new AuditEventError('invalid actor');
  if (!ACTION_RE.test(event.action)) throw new AuditEventError('invalid action');
  const leaked = findRedactedKey(event.metadata ?? {});
  if (leaked) throw new AuditEventError(`metadata key not allowed: ${leaked}`);
  await tx.insert(auditEvents).values({
    tenantId: sql`app.current_tenant_id()`,
    actor: event.actor,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    clientId: event.clientId ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    metadata: event.metadata ?? {},
  });
}

/**
 * Runs a PHI read or write and records it in the same transaction (CLAUDE.md rule 7). If the audit
 * insert fails, the transaction fails and nothing is returned or changed.
 */
export async function withAudit<T>(tx: Tx, event: AuditEvent, fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await recordAudit(tx, event);
  return result;
}
