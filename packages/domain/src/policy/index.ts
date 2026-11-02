/**
 * The single policy module (docs/11-security-hipaa.md: "checks in a single policy module used by
 * every route and job"). Roles and their rights follow the matrix in S-01 (ui/admin.html):
 *
 * |                                         | Owner | Admin | Biller | Viewer |
 * | Work items and claims in their clients  | All   | All   | Work   | View   |
 * | Release claims and post payments        | Yes   | Yes   | Yes    | No     |
 * | Clients, integrations, rules, mappings  | Yes   | Yes   | No     | No     |
 * | Users, security, billing, audit log     | Yes   | Yes   | No     | No     |
 * | Export patient-level data               | Yes   | Yes   | No     | No     |
 *
 * Billers and viewers see only the clients in their scope; owners and admins see every client.
 * RLS separates tenants; this module decides what a member may do inside one.
 */

export type Role = 'admin' | 'biller' | 'viewer';

export interface Actor {
  userId: string;
  role: Role;
  isOwner: boolean;
  clientScope: 'all' | 'list';
  clientIds: readonly string[];
}

export const ACTIONS = [
  // Work queue and claims (client-scoped)
  'work.view',
  'work.resolve',
  'claim.view',
  'claim.edit',
  'claim.release',
  'remittance.view',
  'payment.post',
  /** W-18: accept the difference on an 835 that does not balance (admins, with a reason). */
  'remittance.accept_difference',
  'denial.write_off',
  'patient.view',
  'phi.reveal',
  // Clients
  'client.view',
  'client.create',
  'client.manage',
  'client.offboard',
  // Configuration
  'integration.manage',
  'rules.manage',
  'mappings.manage',
  'automation.manage',
  // Administration
  'users.manage',
  'security.manage',
  'billing.view',
  'audit.view',
  // Reports and exports
  'reports.view',
  'reports.team',
  'phi.export',
  'views.share',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Actions that act on one client's data and so respect client scope. */
const CLIENT_SCOPED = new Set<Action>([
  'work.view',
  'work.resolve',
  'claim.view',
  'claim.edit',
  'claim.release',
  'remittance.view',
  'payment.post',
  'remittance.accept_difference',
  'denial.write_off',
  'patient.view',
  'phi.reveal',
  'client.view',
  'reports.view',
]);

const BILLER = new Set<Action>([
  'work.view',
  'work.resolve',
  'claim.view',
  'claim.edit',
  'claim.release',
  'remittance.view',
  'payment.post',
  'patient.view',
  'phi.reveal',
  'client.view',
  'reports.view',
]);

const VIEWER = new Set<Action>(['work.view', 'claim.view', 'remittance.view', 'client.view', 'reports.view']);

const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  admin: new Set(ACTIONS),
  biller: BILLER,
  viewer: VIEWER,
};

export type Decision = { allowed: true } | { allowed: false; reason: 'role' | 'client_scope' };

export interface Resource {
  /** The client the record belongs to, when the action touches one client's data. */
  clientId?: string | null;
}

export function sees(actor: Actor, clientId: string): boolean {
  return actor.role === 'admin' || actor.clientScope === 'all' || actor.clientIds.includes(clientId);
}

export function authorize(actor: Actor, action: Action, resource: Resource = {}): Decision {
  if (!ROLE_ACTIONS[actor.role].has(action)) return { allowed: false, reason: 'role' };
  if (CLIENT_SCOPED.has(action) && resource.clientId && !sees(actor, resource.clientId)) {
    return { allowed: false, reason: 'client_scope' };
  }
  return { allowed: true };
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(
    readonly action: Action,
    readonly reason: 'role' | 'client_scope',
  ) {
    super(`Not allowed: ${action}`);
    this.name = 'ForbiddenError';
  }
}

export function assertAllowed(actor: Actor, action: Action, resource?: Resource): void {
  const d = authorize(actor, action, resource);
  if (!d.allowed) throw new ForbiddenError(action, d.reason);
}

/**
 * Which clients' rows a list query may return: 'all', or the IDs to filter by. Apply it to every
 * list of client-scoped records.
 */
export function clientFilter(actor: Actor): 'all' | readonly string[] {
  return actor.role === 'admin' || actor.clientScope === 'all' ? 'all' : actor.clientIds;
}
