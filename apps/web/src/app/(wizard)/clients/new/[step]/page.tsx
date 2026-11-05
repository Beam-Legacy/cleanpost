import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import {
  OPERATION_LABEL,
  PROFILES,
  levelLabel,
  type CapabilityMap,
  type Operation,
} from '@cleanpost/adapters';
import {
  ONBOARDING_STEPS,
  awaiting,
  policy,
  recommendMode,
  stepIndex,
  type OnboardingStep,
} from '@cleanpost/domain';
import { now as clockNow } from '@cleanpost/clock';
import { codeMeaning } from '@/lib/mapping-display';
import { PM_CHOICES, defaultFilingDays, REVIEW_EVERYTHING_DAYS } from '@/lib/onboarding/options';
import { mockPmAvailable } from '@/lib/onboarding/pm-mock';
import { clientMappings, clientProviders } from '@/lib/queries/client-detail';
import {
  billerChoices,
  checklistFor,
  companyThreshold,
  onboardingClient,
  payerChoices,
  payerMatches,
} from '@/lib/queries/onboarding';
import { formatDate, formatWhen } from '@/lib/format';
import { requireActiveContext } from '@/lib/session';
import { ClientMappingRow } from '@/app/(app)/clients/[id]/mappings/client-mapping-row';
import { reviewPostingAction } from '../actions';
import { AutomationStep } from '../steps/automation-step';
import { ConnectStep, type TestRow } from '../steps/connect-step';
import { DryRunStep } from '../steps/dry-run-step';
import { GoLiveStep } from '../steps/go-live-step';
import { ModeStep } from '../steps/mode-step';
import { PayersStep } from '../steps/payers-step';
import { PmStep, type PmCard } from '../steps/pm-step';
import { PracticeForm } from '../steps/practice-form';
import { ProvidersStep } from '../steps/providers-step';
import { StepHead, WizardFrame } from '../wizard-frame';
import { ContinueButton, StepFoot } from '../wizard-client';

export const metadata: Metadata = { title: 'Add client' };

/** What O-03 shows for each PM, in the designs' order. */
const CARD_OPS: Operation[] = [
  'pullCharges',
  'holdCharge',
  'pushChargeCorrection',
  'pullClaimsAndStatus',
  'pullPostings',
  'postPayment',
];

const href = (key: OnboardingStep, id: string) => `/clients/new/${key}?client=${id}`;

/**
 * O-01 to O-10, one route per step (ui/clients.html routes /clients/new/<step>), the client being
 * onboarded in `?client=`. A step not reached yet sends the admin to the furthest step reached;
 * a client that is no longer onboarding opens its overview.
 */
export default async function OnboardingStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { step } = await params;
  const key = ONBOARDING_STEPS.find((s) => s.key === step)?.key;
  if (!key) notFound();
  const ctx = await requireActiveContext();
  const raw = (await searchParams).client;
  const clientId = raw && z.uuid().safeParse(raw).success ? raw : null;

  if (!clientId) {
    if (key !== 'practice') redirect('/clients/new/practice');
    if (!policy.authorize(ctx.actor, 'client.create').allowed) notFound();
    return (
      <WizardFrame clientId={null} clientName={null} current="practice" reached={1} savedAt={null}>
        <StepHead title="Practice details">
          These appear on every claim as the billing provider. Start with the group NPI.
        </StepHead>
        <PracticeForm
          clientId={null}
          defaults={{
            name: '',
            billingNpi: '',
            taxIdLast4: null,
            taxonomy: '',
            line1: '',
            city: '',
            state: '',
            zip: '',
            timezone: 'America/Los_Angeles',
            contact: '',
          }}
        />
      </WizardFrame>
    );
  }

  if (!policy.authorize(ctx.actor, 'client.manage', { clientId }).allowed) notFound();
  const c = await onboardingClient(ctx, clientId);
  if (!c) notFound();
  if (c.status !== 'onboarding') redirect(`/clients/${c.id}`);
  const index = stepIndex(key);
  if (index + 1 > c.state.step) redirect(href(ONBOARDING_STEPS[c.state.step - 1]!.key, c.id));
  const back = index > 0 ? href(ONBOARDING_STEPS[index - 1]!.key, c.id) : null;
  const pmName = c.connection?.pmName ?? c.state.pm?.pmName ?? 'the PM';
  const manual = c.state.pm?.adapterKey === 'manual';
  const levels = (
    c.state.pm?.profile && c.state.pm.profile in PROFILES
      ? PROFILES[c.state.pm.profile as keyof typeof PROFILES]
      : PROFILES.manual
  ) as CapabilityMap;

  const frame = (title: string, lead: ReactNode, body: ReactNode) => (
    <WizardFrame
      clientId={c.id}
      clientName={c.name}
      current={key}
      reached={c.state.step}
      savedAt={c.updatedAt}
    >
      <StepHead title={title}>{lead}</StepHead>
      {body}
    </WizardFrame>
  );

  switch (key) {
    case 'practice':
      return frame(
        'Practice details',
        'These appear on every claim as the billing provider.',
        <PracticeForm
          clientId={c.id}
          defaults={{
            name: c.name,
            billingNpi: c.billingNpi ?? '',
            taxIdLast4: c.taxIdLast4,
            taxonomy: c.taxonomy ?? '',
            line1: c.address?.line1 ?? '',
            city: c.address?.city ?? '',
            state: c.address?.state ?? '',
            zip: c.address?.zip ?? '',
            timezone: c.timezone,
            contact: c.state.contact ?? '',
          }}
        />,
      );

    case 'providers': {
      const { providers, locations } = await clientProviders(ctx, c.id);
      return frame(
        'Providers and locations',
        'Add each clinician who sees patients and each place they see them. NPIs are checked as you add them.',
        <ProvidersStep clientId={c.id} providers={providers} locations={locations} back={back!} />,
      );
    }

    case 'pm': {
      const demoHere = mockPmAvailable();
      const cards: PmCard[] = PM_CHOICES.map((p) => ({
        ...p,
        available: p.demo ? demoHere : true,
        ops: CARD_OPS.map((op) => ({
          label: OPERATION_LABEL[op],
          level: levelLabel(PROFILES[p.profile][op]),
          value: PROFILES[p.profile][op],
        })),
      }));
      const chosen = c.state.pm
        ? (PM_CHOICES.find(
            (p) => p.adapterKey === c.state.pm!.adapterKey && p.profile === c.state.pm!.profile,
          )?.key ?? null)
        : null;
      return frame(
        `Which PM system does ${c.name} use?`,
        'Cleanpost works with any PM. Where there is no integration for an operation, Cleanpost prepares the work and a biller completes it in the PM.',
        <PmStep
          clientId={c.id}
          clientName={c.name}
          cards={cards}
          chosen={chosen}
          otherName={chosen === 'manual' ? (c.state.pm?.pmName ?? null) : null}
          back={back!}
        />,
      );
    }

    case 'connect': {
      if (!c.state.pm) redirect(href('pm', c.id));
      const test = c.state.test ?? null;
      const details = test?.details ?? {};
      const failure =
        details.connection === 'auth_failed'
          ? `${pmName} refused the sign-in. Check the API user and key.`
          : details.connection === 'failing' || details.connection === 'not_found'
            ? `${pmName} did not answer. Test again in a moment.`
            : null;
      const rows: TestRow[] = manual
        ? []
        : (Object.keys(OPERATION_LABEL) as Operation[]).map((op) => {
            const lv = levels[op];
            const got = details[op];
            if (lv === 'unavailable')
              return { label: OPERATION_LABEL[op], state: 'unavailable', note: `Not available in ${pmName}` };
            if (lv === 0) return { label: OPERATION_LABEL[op], state: 'manual', note: 'Manual task for now' };
            if (got === 'ok') return { label: OPERATION_LABEL[op], state: 'ok', note: levelLabel(lv) };
            return { label: OPERATION_LABEL[op], state: 'failed', note: 'Did not answer' };
          });
      return frame(
        manual ? `Set up ${pmName}` : `Connect ${pmName}`,
        manual
          ? 'No integration yet: Cleanpost works from file exports and tasks for billers.'
          : `Cleanpost signs in to ${pmName} with a dedicated user and only uses the operations in the connection test.`,
        <ConnectStep
          clientId={c.id}
          pmName={pmName}
          demo={c.state.pm.adapterKey === 'mock'}
          manual={manual}
          connected={Boolean(c.connection)}
          testing={awaiting(c.state.testRequestedAt, test?.checkedAt)}
          test={test ? { ok: test.ok, checkedAt: test.checkedAt, failure } : null}
          rows={rows}
          back={back!}
        />,
      );
    }

    case 'dry-run': {
      const choices = await payerChoices(ctx);
      const unmatched = payerMatches(c, choices).filter((r) => !r.payerId).length;
      return frame(
        manual ? 'Nothing to pull yet' : 'Check the first 7 days',
        manual
          ? undefined
          : `Cleanpost pulls the last 7 days from ${pmName} without sending anything. Check each sample encounter against the PM before going on.`,
        <DryRunStep
          key={c.state.dryRun?.ranAt ?? 'none'}
          clientId={c.id}
          pmName={pmName}
          manual={manual}
          running={awaiting(c.state.dryRunRequestedAt, c.state.dryRun?.ranAt)}
          summary={c.state.dryRun ?? null}
          confirmed={Boolean(c.state.dryRunConfirmed)}
          unmatchedPayers={unmatched}
          providersHref={href('providers', c.id)}
          back={back!}
        />,
      );
    }

    case 'payers': {
      const choices = await payerChoices(ctx);
      const rows = payerMatches(c, choices);
      return frame(
        'Match payers',
        rows.length && c.state.dryRun
          ? `Cleanpost found ${rows.length === 1 ? '1 payer name' : `${rows.length} payer names`} in ${pmName}. Confirm the matches and set how long each payer allows to file.`
          : 'Add the payers this practice bills and how long each allows to file.',
        <PayersStep
          clientId={c.id}
          pmName={pmName}
          rows={rows}
          choices={choices.map((p) => ({
            id: p.id,
            name: p.name,
            stediPayerId: p.stediPayerId,
            defaultDays: defaultFilingDays(p.name),
          }))}
          back={back!}
        />,
      );
    }

    case 'mode': {
      const choices = await payerChoices(ctx);
      const rec = recommendMode(
        Object.fromEntries(
          Object.entries(levels).map(([k, v]) => [k, typeof v === 'number' ? v : -1]),
        ) as Record<string, number>,
      );
      const hold = levels.holdCharge;
      return frame(
        'Choose how claims and payments flow',
        undefined,
        <ModeStep
          clientId={c.id}
          pmName={pmName}
          reason={rec.reason}
          canHold={typeof hold === 'number' && hold >= 2}
          payers={c.payersSetUp.map((p) => ({
            name: choices.find((x) => x.id === p.payerId)?.name ?? p.pmPayerName ?? 'Payer',
            timelyFilingDays: p.timelyFilingDays,
          }))}
          back={back!}
        />,
      );
    }

    case 'posting': {
      const { pmType, rows } = await clientMappings(ctx, c.id);
      const unmapped = rows.filter((r) => r.source === 'unmapped').length;
      return frame(
        'Posting rules',
        `This is how each adjustment on a payer's remittance is recorded in ${pmName}. Your company's mappings for ${pmName} are filled in; change one only if this practice records it differently.`,
        <>
          {!pmType ? (
            <p className="muted">Connect the PM first.</p>
          ) : (
            <div className="card flush">
              <div className="table-wrap">
                <table className="table" aria-label={`${pmName} adjustment mappings for ${c.name}`}>
                  <thead>
                    <tr>
                      <th>835 code</th>
                      <th>Meaning</th>
                      <th>{pmName} code</th>
                      <th>What happens</th>
                      <th>Source</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <ClientMappingRow
                        key={`${r.groupCode}-${r.carc}`}
                        clientId={c.id}
                        row={r}
                        meaning={codeMeaning(r.groupCode, r.carc)}
                        pmName={pmName}
                        canEdit
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-foot">
                <span className="subtle dense">
                  {unmapped
                    ? `${unmapped === 1 ? '1 code needs' : `${unmapped} codes need`} a decision.`
                    : 'No unmapped codes.'}{' '}
                  Denial codes are never mapped: their balance stays open for follow-up.
                </span>
              </div>
            </div>
          )}
          <StepFoot back={back}>
            <ContinueButton
              disabled={!pmType || unmapped > 0}
              action={reviewPostingAction.bind(null, c.id, unmapped)}
            />
          </StepFoot>
        </>,
      );
    }

    case 'automation': {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone }).format(clockNow());
      const ends = new Date(Date.parse(`${today}T12:00:00Z`) + REVIEW_EVERYTHING_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return frame(
        'How much should go out without review?',
        'Every claim gets a confidence score. Claims at or above the threshold go out automatically; the rest wait in the work queue.',
        <AutomationStep
          clientId={c.id}
          clientName={c.name}
          reviewEndsOn={formatDate(ends)}
          initial={{
            reviewEverything: c.state.automationSet ? Boolean(c.reviewUntil) : true,
            threshold: c.threshold,
          }}
          companyDefault={await companyThreshold(ctx)}
          back={back!}
        />,
      );
    }

    case 'go-live': {
      const items = checklistFor(c);
      const billers = await billerChoices(ctx, c.id);
      const nameOf = (id: string | null) => billers.find((b) => b.id === id)?.name;
      const details: Record<string, string> = {
        practice: `${c.renderingProviders === 1 ? '1 rendering provider' : `${c.renderingProviders} rendering providers`}, ${c.locations === 1 ? '1 location' : `${c.locations} locations`}; NPIs pass their check digit`,
        connection: manual
          ? `${pmName}: no integration, files and tasks`
          : c.state.test?.ok
            ? `Tested ${formatWhen(new Date(c.state.test.checkedAt))}`
            : 'Test the connection',
        'dry-run': manual
          ? 'Nothing to pull for a manual PM'
          : c.state.dryRunConfirmed && c.state.dryRun
            ? `${c.state.dryRun.samples.length} of ${c.state.dryRun.samples.length} sample encounters checked`
            : 'Check the sample encounters',
        payers: `${c.payersSetUp.length === 1 ? '1 payer' : `${c.payersSetUp.length} payers`}`,
        mode: c.state.modeChosen ? `Mode ${c.mode} · ${pmName} sends, Cleanpost checks` : 'Choose a mode',
        posting: c.state.postingReviewed ? 'No unmapped codes' : 'Review the mappings',
        automation: !c.state.automationSet
          ? 'Choose review-everything or a threshold'
          : c.reviewUntil
            ? `Review everything until ${formatDate(c.reviewUntil)}, then threshold ${c.threshold ?? 'from the company default'}`
            : `Threshold ${c.threshold ?? 'from the company default'} from day one`,
        billers:
          c.primaryBillerId && c.backupBillerId
            ? `${nameOf(c.primaryBillerId) ?? 'Primary'} (primary), ${nameOf(c.backupBillerId) ?? 'backup'} (backup)`
            : c.primaryBillerId
              ? 'Choose a backup biller'
              : 'Choose a primary and a backup biller',
        informed: c.state.practiceInformed ? 'Done' : 'Send the template email or mark it done',
      };
      const contact = c.state.contact?.split(',')[0]?.trim();
      const until = c.reviewUntil ? formatDate(c.reviewUntil) : null;
      const email = [
        `Hi${contact ? ` ${contact}` : ''},`,
        '',
        `Starting today, ${c.name}'s claims are checked by Cleanpost before ${pmName} sends them. Nothing changes in how you enter charges in ${pmName}.`,
        manual
          ? 'Keep sending the daily charge export as you do now.'
          : `Charges wait in ${pmName} until they are checked, usually within a business day.`,
        until
          ? `Until ${until}, a biller reviews every claim, so the first claims may take a little longer.`
          : '',
        `Your billers are ${nameOf(c.primaryBillerId) ?? 'your primary biller'} and ${nameOf(c.backupBillerId) ?? 'a backup'}. Questions about a claim go to them as usual.`,
        '',
        'Thank you',
      ]
        .filter((l, i, a) => l !== '' || a[i - 1] !== '')
        .join('\n');
      return frame(
        'Ready to go live?',
        `Everything below must be done before Cleanpost starts working ${c.name}'s claims.`,
        <GoLiveStep
          clientId={c.id}
          items={items}
          details={details}
          billers={billers}
          primaryId={c.primaryBillerId}
          backupId={c.backupBillerId}
          informed={Boolean(c.state.practiceInformed)}
          email={email}
          firstSyncNote={
            manual
              ? 'Cleanpost starts with the next charge file you upload.'
              : `Cleanpost starts today. The first sync pulls the charges ${pmName} has from the last weeks that it has not sent yet; charges already sent stay with ${pmName}.`
          }
          back={back!}
        />,
      );
    }
  }
}
