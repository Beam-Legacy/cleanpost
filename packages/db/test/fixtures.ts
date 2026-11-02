/**
 * One row in every tenant table for a tenant, inserted as the owner (bypassing RLS) so isolation
 * tests can check each table from the other side. Synthetic values only.
 */
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../src';
import * as s from '../src/schema';
import { syntheticMemberId } from '@cleanpost/testing';

export interface TenantFixture {
  tenant: string;
  user: string;
  client: string;
}

export function newFixture(): TenantFixture {
  return { tenant: uuidv7(), user: uuidv7(), client: uuidv7() };
}

export async function insertTenantFixture(db: Database, f: TenantFixture, label: string, payerId: string) {
  const { tenant: tenantId, client: clientId } = f;
  const t = { tenantId };
  const tc = { tenantId, clientId };
  await db.insert(s.users).values({ id: f.user, name: `User ${label}`, email: `${f.user}@example.test` });
  await db.insert(s.tenants).values({ id: tenantId, name: label });
  await db.insert(s.memberships).values({ ...t, userId: f.user, role: 'admin', isOwner: true });
  await db.insert(s.clients).values({ id: clientId, ...t, name: `Client of ${label}` });
  await db.insert(s.userPreferences).values({ ...t, userId: f.user });
  await db.insert(s.auditEvents).values({
    ...t,
    actor: `user:${f.user}`,
    action: 'client.created',
    entityType: 'client',
    entityId: clientId,
  });
  await db.insert(s.clientPayerSettings).values({ ...tc, payerId });
  const [provider] = await db
    .insert(s.providers)
    .values({ ...tc, npi: '1932204417', name: 'Provider' })
    .returning();
  const [location] = await db
    .insert(s.locations)
    .values({ ...tc, name: 'Main office' })
    .returning();
  const [patient] = await db
    .insert(s.patients)
    .values({ ...tc, firstName: 'Mai', lastName: 'Nguyen', dob: '1984-03-12', sex: 'F' })
    .returning();
  const [coverage] = await db
    .insert(s.coverages)
    .values({
      ...tc,
      patientId: patient!.id,
      payerId,
      payerName: 'Aetna',
      priority: 1,
      memberIdEncrypted: 'test',
      memberIdLast4: syntheticMemberId(1).slice(-4),
    })
    .returning();
  await db.insert(s.eligibilityChecks).values({ ...tc, coverageId: coverage!.id, status: 'active' });
  const [document] = await db
    .insert(s.documents)
    .values({ ...tc, patientId: patient!.id, type: 'insurance_card_front', storageKey: 'k' })
    .returning();
  const [encounter] = await db
    .insert(s.encounters)
    .values({
      ...tc,
      patientId: patient!.id,
      dateOfService: '2026-10-27',
      renderingProviderId: provider!.id,
      locationId: location!.id,
    })
    .returning();
  const [charge] = await db
    .insert(s.chargeLines)
    .values({ ...tc, encounterId: encounter!.id, lineNumber: 1, code: '99213', chargeCents: 14500 })
    .returning();
  await db.insert(s.diagnoses).values({ ...tc, encounterId: encounter!.id, sequence: 1, icd10: 'E11.9' });
  const [claim] = await db
    .insert(s.claims)
    .values({
      ...tc,
      patientId: patient!.id,
      encounterId: encounter!.id,
      payerId,
      coverageId: coverage!.id,
      patientControlNumber: `PCN-${label.slice(0, 3)}-1`,
      mode: 'A',
      totalChargeCents: 14500,
    })
    .returning();
  const [version] = await db
    .insert(s.claimVersions)
    .values({ ...tc, claimId: claim!.id, version: 1, payload: {}, createdBy: 'system' })
    .returning();
  await db.insert(s.claimLines).values({
    ...tc,
    claimVersionId: version!.id,
    lineNumber: 1,
    chargeLineId: charge!.id,
    code: '99213',
    chargeCents: 14500,
  });
  await db
    .insert(s.scrubResults)
    .values({ ...tc, claimVersionId: version!.id, confidence: 90, decision: 'review', rulesVersion: 'v1' });
  await db.insert(s.claimEvents).values({ ...tc, claimId: claim!.id, type: 'built', actor: 'system' });
  const [remittance] = await db
    .insert(s.remittances)
    .values({
      ...tc,
      payerName: 'Aetna',
      source: 'file',
      traceNumber: '8841203',
      paymentMethod: 'ACH',
      paymentAmountCents: 12112,
      paymentDate: '2026-10-21',
    })
    .returning();
  const [remitClaim] = await db
    .insert(s.remitClaims)
    .values({
      ...tc,
      remittanceId: remittance!.id,
      claimId: claim!.id,
      claimStatusCode: '1',
      chargeCents: 14500,
      paidCents: 12112,
    })
    .returning();
  const [remitLine] = await db
    .insert(s.remitLines)
    .values({ ...tc, remitClaimId: remitClaim!.id, code: '99213', chargeCents: 14500, paidCents: 12112 })
    .returning();
  await db
    .insert(s.remitAdjustments)
    .values({ ...tc, remitLineId: remitLine!.id, groupCode: 'CO', carc: '45', amountCents: 2388 });
  await db.insert(s.remitRemarks).values({ ...tc, remitClaimId: remitClaim!.id, rarc: 'N130' });
  await db
    .insert(s.providerAdjustments)
    .values({ ...tc, remittanceId: remittance!.id, reasonCode: 'L6', amountCents: -1220 });
  await db.insert(s.adjustmentMappings).values({
    ...t,
    pmType: 'tebra',
    groupCode: 'CO',
    carc: '45',
    pmAdjustmentCode: 'CONTR',
    action: 'write_off',
  });
  const [connection] = await db
    .insert(s.connections)
    .values({ ...tc, adapterKey: 'mock' })
    .returning();
  await db
    .insert(s.postings)
    .values({ ...tc, remittanceId: remittance!.id, connectionId: connection!.id, method: 'pm_native' });
  await db.insert(s.pmPostings).values({
    ...tc,
    connectionId: connection!.id,
    externalKey: `${label}-posting`,
    traceNumber: 'EFT1',
    encounterExternalId: 'E1',
    paidCents: 100,
    adjustments: [],
    patientRespCents: 0,
    postedAt: new Date(),
  });
  const [workItem] = await db
    .insert(s.workItems)
    .values({
      ...t,
      clientId,
      type: 'claim_review',
      dueAt: new Date(),
      reasonCode: 'confidence_below_threshold',
      summary: 'Review claim',
      claimId: claim!.id,
      documentId: document!.id,
    })
    .returning();
  await db
    .insert(s.corrections)
    .values({ ...t, clientId, workItemId: workItem!.id, fieldPath: 'lines[0].modifiers', userId: f.user });
  await db.insert(s.writeOffRequests).values({
    ...t,
    clientId,
    claimId: claim!.id,
    denialItemId: workItem!.id,
    amountCents: 60_000,
    reason: 'Not worth pursuing',
    pmCode: 'WO',
    requestedBy: f.user,
  });
  await db.insert(s.rules).values({
    ...t,
    scope: 'tenant',
    name: 'Tenant rule',
    kind: 'validate',
    condition: {},
    action: {},
    severity: 'warn',
    source: 'user',
  });
  await db.insert(s.savedViews).values({ ...t, userId: f.user, surface: 'work', name: 'Mine' });
  await db.insert(s.notificationRules).values({ ...t, eventType: 'sla_breach' });
  await db
    .insert(s.notifications)
    .values({ ...t, userId: f.user, type: 'sla_breach', summary: 'An item is overdue' });
  await db.insert(s.syncRuns).values({ ...tc, connectionId: connection!.id, operation: 'pullCharges' });
  await db
    .insert(s.rateLimitBuckets)
    .values({ ...t, key: `account-${label}`, endpoint: 'GetCharges', tokens: 1 });
  await db.insert(s.externalRefs).values({
    ...tc,
    connectionId: connection!.id,
    entityType: 'patient',
    entityId: patient!.id,
    externalId: `P-${label}`,
  });
  await db
    .insert(s.manualTasks)
    .values({ ...tc, connectionId: connection!.id, operation: 'postPayment', title: 'Post payment' });
  await db.insert(s.tenantAgreements).values({ ...t, type: 'baa', version: '1' });
  await db.insert(s.dataExports).values({ ...t, type: 'audit_csv', requestedBy: f.user });
  await db.insert(s.invoices).values({
    ...t,
    number: `INV-${label}`,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    amountCents: 650000,
  });
  await db.insert(s.integrationRequests).values({ ...t, pmName: 'AdvancedMD', createdBy: f.user });
  await db
    .insert(s.breakGlassGrants)
    .values({ ...t, operatorUserId: uuidv7(), reason: 'Test', expiresAt: new Date(Date.now() + 3_600_000) });
  await db.insert(s.usageRecords).values({ ...t, clientId, date: '2026-10-31', claimsReleased: 10 });
  return { claimVersionId: version!.id, claimId: claim!.id };
}
