/**
 * Onboarding a client (O-01 to O-11, docs/13-cx-onboarding.md): the steps, what the wizard keeps
 * between visits (`clients.onboarding`, counts and names only, never patient data), and the go-live
 * checklist that O-10 shows and Go live requires.
 */
export const ONBOARDING_STEPS = [
  { key: 'practice', view: 'O-01', label: 'Practice' },
  { key: 'providers', view: 'O-02', label: 'Providers and locations' },
  { key: 'pm', view: 'O-03', label: 'PM system' },
  { key: 'connect', view: 'O-04', label: 'Connect' },
  { key: 'dry-run', view: 'O-05', label: 'Dry run' },
  { key: 'payers', view: 'O-06', label: 'Payers' },
  { key: 'mode', view: 'O-07', label: 'Mode' },
  { key: 'posting', view: 'O-08', label: 'Posting rules' },
  { key: 'automation', view: 'O-09', label: 'Automation' },
  { key: 'go-live', view: 'O-10', label: 'Go live' },
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]['key'];

export const stepIndex = (key: string) => ONBOARDING_STEPS.findIndex((s) => s.key === key);

/** Up to `n` items spread evenly across a list (first, last and in between). */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const step = (items.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => items[Math.round(i * step)]!);
}

/**
 * One encounter to spot-check against the PM (O-05): the PM's encounter number, the codes, the
 * charge and the primary payer. No patient name or date, so `clients.onboarding` holds no PHI.
 */
export interface DryRunSample {
  encounterId: string;
  codes: string[];
  chargeCents: number;
  payer: string | null;
}

/** What a read-only pull of the last days found (O-05): counts and names, no patient data. */
export interface DryRunSummary {
  ranAt: string;
  days: number;
  patients: number;
  encounters: number;
  lines: number;
  /** Payer names on the practice's coverages, with how many patients each. */
  payers: { name: string; patients: number }[];
  /** Rendering or referring NPIs on charges that are not set up in O-02. */
  unknownNpis: string[];
  /** The PM's location IDs on charges. */
  locations: string[];
  /** Records the adapter could not read. */
  rejected: number;
  /** Up to 10 encounters spread across the pull, for the spot check. */
  samples: DryRunSample[];
}

export interface OnboardingState {
  /** Furthest step reached, 1 to 10. */
  step: number;
  pm?: { adapterKey: string; profile: string | null; pmName: string };
  test?: { ok: boolean; checkedAt: string; details: Record<string, string> };
  dryRun?: DryRunSummary;
  dryRunConfirmed?: boolean;
  modeChosen?: boolean;
  postingReviewed?: boolean;
  automationSet?: boolean;
  practiceInformed?: boolean;
  /** When the admin last asked for a test or a dry run; the page waits for a result newer than this. */
  testRequestedAt?: string;
  dryRunRequestedAt?: string;
  /** Who ticked every spot-check sample (user ID). */
  dryRunCheckedBy?: string;
  /** The practice's billing contact (a workforce name, e.g. the office manager), for the O-10 email. */
  contact?: string;
  /** Last four digits of the tax ID, for the masked display (the full value is field-encrypted). */
  taxIdLast4?: string;
  /** Set by Go live; O-11 shows once, then the route goes to the client overview. */
  liveAt?: string;
  /** O-11 has been shown. */
  liveShown?: boolean;
}

/** Waiting for the worker: asked after the last result came back. */
export function awaiting(requestedAt: string | undefined, resultAt: string | undefined): boolean {
  return Boolean(requestedAt && (!resultAt || resultAt < requestedAt));
}

export function readOnboarding(raw: unknown): OnboardingState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<OnboardingState>;
  return { ...o, step: typeof o.step === 'number' && o.step >= 1 && o.step <= 10 ? o.step : 1 };
}

export interface GoLiveFacts {
  practiceComplete: boolean;
  renderingProviders: number;
  locations: number;
  connectionTested: boolean;
  dryRunConfirmed: boolean;
  /** Payer names from the dry run with no payer set up for the client. */
  unmatchedPayers: number;
  payersSetUp: number;
  modeChosen: boolean;
  postingReviewed: boolean;
  automationSet: boolean;
  primaryBiller: boolean;
  backupBiller: boolean;
  practiceInformed: boolean;
}

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  /** The step that fixes it. */
  fix: OnboardingStep;
}

/** docs/13 "Client go-live checklist", computed from what was saved. Go live needs every item. */
export function goLiveChecklist(f: GoLiveFacts): ChecklistItem[] {
  return [
    {
      key: 'practice',
      label: 'Practice, providers and locations complete; NPIs pass their check digit',
      ok: f.practiceComplete && f.renderingProviders > 0 && f.locations > 0,
      fix: f.practiceComplete ? 'providers' : 'practice',
    },
    { key: 'connection', label: 'Connection tested', ok: f.connectionTested, fix: 'connect' },
    {
      key: 'dry-run',
      label: 'Dry-run pull reviewed: counts look right',
      ok: f.dryRunConfirmed,
      fix: 'dry-run',
    },
    {
      key: 'payers',
      label: 'Payers matched to Stedi payer IDs; timely filing days set',
      ok: f.payersSetUp > 0 && f.unmatchedPayers === 0,
      fix: 'payers',
    },
    { key: 'mode', label: 'Mode chosen', ok: f.modeChosen, fix: 'mode' },
    { key: 'posting', label: 'Adjustment mappings reviewed', ok: f.postingReviewed, fix: 'posting' },
    {
      key: 'automation',
      label: 'Release threshold set (or review everything)',
      ok: f.automationSet,
      fix: 'automation',
    },
    {
      key: 'billers',
      label: 'Primary and backup biller assigned',
      ok: f.primaryBiller && f.backupBiller,
      fix: 'go-live',
    },
    {
      key: 'informed',
      label: 'Practice informed of the go-live date',
      ok: f.practiceInformed,
      fix: 'go-live',
    },
  ];
}

/** O-07: what the PM can do decides the recommended mode (docs/04-modes.md). Mode A is built today. */
export function recommendMode(levels: Record<string, number>): { mode: 'A' | 'B' | 'C'; reason: string } {
  const can = (op: string) => (levels[op] ?? 0) >= 2;
  if (can('holdCharge'))
    return {
      mode: 'A',
      reason: 'The PM can hold charges, so it keeps sending claims while Cleanpost checks each one first.',
    };
  return {
    mode: 'A',
    reason:
      'The PM sends its own claims; Cleanpost checks them and follows them up. Modes B and C come later.',
  };
}
