import 'server-only';
/**
 * Reports (RP-01 to RP-05, DEC-20) for the signed-in user: the figures come from
 * `@cleanpost/reports`, limited to the clients in the user's scope.
 */
import { policy, type reports as r } from '@cleanpost/domain';
import * as reports from '@cleanpost/reports';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export {
  DENIAL_GROUPS,
  denialGroup,
  todayPacific,
  type Aging,
  type AgingRow,
  type BacklogRow,
  type ClientRow,
  type DenialCodeRow,
  type DenialGroup,
  type DenialsReport,
  type Kpis,
  type Overview,
  type PayerRow,
  type ReportClient,
  type TeamReport,
  type TeamRow,
} from '@cleanpost/reports';

const scopeOf = (ctx: ActiveContext): reports.ReportScope => ({
  tenantId: ctx.tenantId,
  userId: ctx.user.id,
  clients: policy.clientFilter(ctx.actor),
});

export const getOverview = (ctx: ActiveContext, period: r.Period, clientId?: string) =>
  reports.getOverview(getDb(), scopeOf(ctx), period, clientId);

export const getPayerResults = (ctx: ActiveContext, clientId: string, period: r.Period) =>
  reports.getPayerResults(getDb(), scopeOf(ctx), clientId, period);

export const getReportClients = (ctx: ActiveContext) => reports.getReportClients(getDb(), scopeOf(ctx));

export const getReportClient = (ctx: ActiveContext, clientId: string) =>
  reports.getReportClient(getDb(), scopeOf(ctx), clientId);

export const getAging = (
  ctx: ActiveContext,
  opts: { view: 'insurance' | 'patient'; groupBy: 'payer' | 'client'; clientId?: string },
) => reports.getAging(getDb(), scopeOf(ctx), opts);

export const getDenialsReport = (
  ctx: ActiveContext,
  period: r.Period,
  filters: { clientId?: string; payer?: string } = {},
) => reports.getDenialsReport(getDb(), scopeOf(ctx), period, filters);

export const getTeamReport = (ctx: ActiveContext, period: r.Period) =>
  reports.getTeamReport(getDb(), scopeOf(ctx), period);
