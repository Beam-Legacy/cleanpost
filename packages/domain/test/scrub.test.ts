import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@cleanpost/testing/vitest';
import { generatePractice, type SpecialtyKey } from '@cleanpost/testing/synth';
import { describe, expect, it } from 'vitest';
import {
  buildClaimPayload,
  evaluate,
  npiFromBase,
  parseRuleFile,
  referenceFileSchema,
  runScrubSteps,
  scoreClaim,
  type ClaimPayload,
  type Finding,
  type RuleDef,
  type ScrubInput,
} from '../src';

const seedRules: RuleDef[] = ['coding.json', 'payers.json'].flatMap((f) =>
  parseRuleFile(JSON.parse(readFileSync(join(REPO_ROOT, 'rules/seed', f), 'utf8'))),
);
const ref = referenceFileSchema.parse(
  JSON.parse(readFileSync(join(REPO_ROOT, 'rules/seed/reference.json'), 'utf8')),
);
const icd10 = new Map<string, { billable: boolean }>([
  ...ref.icd10.billable.map((c) => [c, { billable: true }] as const),
  ...ref.icd10.headers.map((c) => [c, { billable: false }] as const),
]);

const NPI_BILLING = npiFromBase('148772659');
const NPI_RENDERING = npiFromBase('193220441');

function input(payload: ClaimPayload, overrides: Partial<ScrubInput> = {}): ScrubInput {
  return {
    clientId: 'client-1',
    claim: payload,
    patient: { sex: 'F', ageYears: 52 },
    coverage: {
      id: 'cov-1',
      payerId: payload.payerId,
      payerName: payload.payerName ?? 'Aetna',
      effectiveDate: '2024-01-01',
      terminationDate: null,
      memberIdPresent: true,
      relationship: 'self',
      subscriberPresent: false,
    },
    eligibility: null,
    reference: { icd10, procedures: new Set(ref.procedures) },
    ncci: ref.ncci,
    mue: ref.mue,
    rules: seedRules,
    history: { duplicates: [] },
    today: '2026-11-02',
    ...overrides,
  };
}

const payload = (
  lines: { code: string; modifiers?: string[]; units?: number; pointers?: number[] }[],
  extra: Partial<ClaimPayload> = {},
): ClaimPayload => ({
  ...buildClaimPayload(
    {
      id: 'enc',
      dateOfService: '2026-10-27',
      status: 'ready',
      pmStatus: 'Review',
      updatedAt: new Date('2026-10-27T20:00:00Z'),
      renderingProvider: { id: 'p1', npi: NPI_RENDERING, taxonomy: null },
      referringProviderNpi: null,
      location: { id: 'l1', placeOfService: '11', npi: null },
      priorAuthNumber: null,
      diagnoses: [
        { sequence: 1, icd10: 'M17.11' },
        { sequence: 2, icd10: 'I10' },
      ],
      lines: lines.map((l, i) => ({
        id: `cl${i + 1}`,
        lineNumber: i + 1,
        code: l.code,
        modifiers: l.modifiers ?? [],
        units: l.units ?? 1,
        chargeCents: 10_000,
        diagnosisPointers: l.pointers ?? [1],
        ndc: null,
      })),
    },
    {
      patientId: 'pat',
      coverage: { id: 'cov-1', payerId: 'payer-1', payerName: 'Aetna' },
      client: { billingNpi: NPI_BILLING, taxonomy: null },
      timelyFilingDays: 120,
    },
  ),
  ...extra,
});

const ids = (fs: Finding[]) => fs.map((f) => f.ruleId);

describe('rules DSL', () => {
  it('validates every seed rule file', () => {
    expect(seedRules.length).toBeGreaterThanOrEqual(4);
    expect(() =>
      parseRuleFile({ rules: [{ ...seedRules[0], condition: { anyLine: { nope: 1 } } }] }),
    ).toThrow();
  });

  it('evaluates line, field and boolean conditions and reports matched lines', () => {
    const claim = {
      payerId: 'p',
      placeOfService: '11',
      priorAuthNumber: null,
      diagnoses: [{ sequence: 1, icd10: 'M17.11' }],
      lines: [
        { lineNumber: 1, code: '99213', modifiers: [], units: 1 },
        { lineNumber: 2, code: '20610', modifiers: ['RT'], units: 1 },
      ],
      patient: { sex: 'F' as const, ageYears: 40 },
    };
    expect(evaluate({ anyLine: { codeInGroup: 'em_office', modifierNotIn: ['25'] } }, claim)).toEqual({
      matched: true,
      lineNumbers: [1],
    });
    expect(evaluate({ noLine: { codeIn: ['29881'] } }, claim).matched).toBe(true);
    expect(evaluate({ field: 'priorAuthNumber', exists: false }, claim).matched).toBe(true);
    expect(evaluate({ not: { diagnosisPrefixIn: ['M17'] } }, claim).matched).toBe(false);
    expect(evaluate({ field: 'patient.ageYears', gt: 65 }, claim).matched).toBe(false);
  });
});

describe('scrub steps', () => {
  it('passes a clean claim with only the not-yet-checked eligibility note', () => {
    const out = runScrubSteps(
      input(
        payload([
          { code: '99213', modifiers: ['25'] },
          { code: '20610', modifiers: ['RT'] },
        ]),
      ),
    );
    expect(ids(out.findings)).toEqual(['eligibility.not_checked']);
  });

  it('blocks a missing modifier 25 and suggests adding it to the E/M line', () => {
    const out = runScrubSteps(input(payload([{ code: '99214' }, { code: '20610', modifiers: ['RT'] }])));
    const f = out.findings.find((x) => x.ruleId === 'seed.coding.em_with_minor_procedure_needs_25')!;
    expect(f).toMatchObject({
      severity: 'block',
      lineNumbers: [1],
      suggestedFix: { op: 'addModifier', modifier: '25' },
    });
  });

  it('blocks NCCI pairs unless a bypass modifier applies, and units over the MUE', () => {
    const pair = runScrubSteps(input(payload([{ code: '97140' }, { code: '97530' }])));
    expect(ids(pair.findings)).toContain('ncci.ptp.97140.97530');
    const bypassed = runScrubSteps(input(payload([{ code: '97140' }, { code: '97530', modifiers: ['59'] }])));
    expect(ids(bypassed.findings)).not.toContain('ncci.ptp.97140.97530');
    const never = runScrubSteps(
      input(
        payload([
          { code: '20610', modifiers: ['RT'] },
          { code: '76942', modifiers: ['59'] },
        ]),
      ),
    );
    expect(ids(never.findings)).toContain('ncci.ptp.20610.76942');
    const mue = runScrubSteps(input(payload([{ code: '20610', modifiers: ['RT'], units: 3 }])));
    expect(ids(mue.findings)).toContain('ncci.mue.20610');
  });

  it('blocks structural problems with the field named', () => {
    const out = runScrubSteps(
      input(payload([{ code: '99213', pointers: [3] }], { billing: { npi: '1234567890', taxonomy: null } })),
    );
    expect(out.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'structural.pointer_invalid',
          field: 'lines[1].dxPointers',
          lineNumbers: [1],
        }),
        expect.objectContaining({ ruleId: 'structural.billing_npi_invalid', field: 'billing.npi' }),
      ]),
    );
  });

  it('blocks header ICD-10 codes and invalid modifiers; warns on unknown codes', () => {
    const p = payload([{ code: '99213', modifiers: ['ZZ'] }, { code: '12345' }]);
    p.diagnoses = [{ sequence: 1, icd10: 'M17.1' }];
    const fs = runScrubSteps(input(p)).findings;
    expect(ids(fs)).toEqual(
      expect.arrayContaining(['codes.icd10_header', 'codes.modifier_invalid', 'codes.procedure_unknown']),
    );
    expect(fs.find((f) => f.ruleId === 'codes.procedure_unknown')!.severity).toBe('warn');
  });

  it('blocks inactive or ended coverage and a payer mismatch', () => {
    const p = payload([{ code: '99213' }]);
    const checked = new Date('2026-10-26T00:00:00Z');
    expect(
      ids(runScrubSteps(input(p, { eligibility: { status: 'inactive', checkedAt: checked } })).findings),
    ).toContain('eligibility.inactive');
    expect(
      ids(
        runScrubSteps(
          input(p, { eligibility: { status: 'active', checkedAt: checked, otherPayerName: 'Cigna' } }),
        ).findings,
      ),
    ).toContain('eligibility.payer_mismatch');
    const ended = input(p);
    ended.coverage!.terminationDate = '2026-09-30';
    expect(ids(runScrubSteps(ended).findings)).toContain('eligibility.terminated');
  });

  it('applies client rules only to their client and route rules as routes', () => {
    const clientRule: RuleDef = {
      ...seedRules[0]!,
      id: 'client.pos',
      scope: 'client',
      clientId: '01a00000-0000-7000-8000-0000000000c1',
      kind: 'route',
      condition: { field: 'placeOfService', eq: '11' },
      action: { finding: 'Route', route: { queue: 'ortho' } },
    };
    const mine = runScrubSteps(
      input(payload([{ code: '99213' }]), { rules: [clientRule], clientId: clientRule.clientId! }),
    );
    expect(mine.routes).toEqual([{ ruleId: 'client.pos', queue: 'ortho' }]);
    expect(runScrubSteps(input(payload([{ code: '99213' }]), { rules: [clientRule] })).routes).toEqual([]);
  });
});

describe('confidence', () => {
  const warn = (w = 15): Finding => ({
    ruleId: 'w',
    step: 'payer',
    severity: 'warn',
    field: 'x',
    message: 'm',
    weight: w,
  });
  it('follows the documented formula', () => {
    expect(
      scoreClaim([], { threshold: 90, firstClaimForClientPayer: false, payerFirstPassRate: null }),
    ).toMatchObject({
      confidence: 100,
      decision: 'auto_release',
    });
    expect(
      scoreClaim([warn()], { threshold: 90, firstClaimForClientPayer: false, payerFirstPassRate: 0.95 }),
    ).toMatchObject({
      confidence: 85,
      decision: 'review',
    });
    expect(
      scoreClaim([], { threshold: 90, firstClaimForClientPayer: true, payerFirstPassRate: 0.8 }),
    ).toMatchObject({
      confidence: 70,
      decision: 'review',
    });
    const blocked = scoreClaim([{ ...warn(), severity: 'block' }], {
      threshold: 0,
      firstClaimForClientPayer: false,
      payerFirstPassRate: null,
    });
    expect(blocked.decision).toBe('blocked');
    expect(
      scoreClaim([warn(60), warn(60)], {
        threshold: 0,
        firstClaimForClientPayer: false,
        payerFirstPassRate: null,
      }).confidence,
    ).toBe(0);
  });
});

describe('accuracy against the generator answer key (M2 acceptance: >= 95% caught, <= 5% false blocks)', () => {
  const PRACTICES: {
    specialty: SpecialtyKey;
    locations: { externalId: string; placeOfService: string }[];
  }[] = [
    { specialty: 'family_medicine', locations: [{ externalId: 'L1', placeOfService: '11' }] },
    { specialty: 'pediatrics', locations: [{ externalId: 'L1', placeOfService: '11' }] },
    {
      specialty: 'orthopedics',
      locations: [
        { externalId: 'L1', placeOfService: '11' },
        { externalId: 'L2', placeOfService: '24' },
      ],
    },
  ];

  it.each(PRACTICES)('$specialty', ({ specialty, locations }) => {
    const data = generatePractice({
      seed: `accuracy-${specialty}`,
      idPrefix: 'ACC',
      specialty,
      city: 'Portland',
      state: 'OR',
      zips: ['97201'],
      areaCode: '503',
      providers: [{ npi: NPI_RENDERING }],
      locations,
      payers: [
        { name: 'Medicare', kind: 'medicare' },
        { name: 'Aetna', kind: 'commercial' },
      ],
      patients: 150,
      encounters: 600,
      asOf: new Date('2026-10-30T12:00:00Z'),
    });
    let defects = 0;
    let caught = 0;
    let clean = 0;
    let falseBlocks = 0;
    const seen: { patient: string; dos: string; codes: string[] }[] = [];
    for (const e of data.encounters) {
      const p = buildClaimPayload(
        {
          id: e.externalId,
          dateOfService: e.dateOfService,
          status: 'ready',
          pmStatus: 'Review',
          updatedAt: new Date(e.updatedAt),
          renderingProvider: { id: 'p1', npi: e.renderingProviderNpi, taxonomy: null },
          referringProviderNpi: null,
          location: { id: e.locationExternalId, placeOfService: e.placeOfService, npi: null },
          priorAuthNumber: e.priorAuthNumber ?? null,
          diagnoses: e.diagnoses,
          lines: e.lines.map((l, i) => ({
            id: l.externalId,
            lineNumber: i + 1,
            code: l.code,
            modifiers: l.modifiers,
            units: l.units,
            chargeCents: l.chargeCents,
            diagnosisPointers: l.diagnosisPointers,
            ndc: null,
          })),
        },
        {
          patientId: e.patientExternalId,
          coverage: { id: 'cov', payerId: 'payer-1', payerName: 'Aetna' },
          client: { billingNpi: NPI_BILLING, taxonomy: null },
          timelyFilingDays: 120,
        },
      );
      const codes = p.lines.map((l) => l.code);
      const duplicates = seen
        .filter(
          (s) =>
            s.patient === e.patientExternalId &&
            s.dos === e.dateOfService &&
            s.codes.some((c) => codes.includes(c)),
        )
        .map((s) => ({ encounterId: s.patient, codes: s.codes }));
      seen.push({ patient: e.patientExternalId, dos: e.dateOfService, codes });
      const out = runScrubSteps(input(p, { history: { duplicates } }));
      const blocked = out.findings.some((f) => f.severity === 'block');
      if (data.answerKey.encounters[e.externalId]?.length) {
        defects++;
        if (blocked) caught++;
      } else {
        clean++;
        if (blocked) falseBlocks++;
      }
    }
    expect(defects).toBeGreaterThan(0);
    // SCRUB_ACCURACY_REPORT=1 prints the rates (synthetic counts only, no record data).
    if (process.env.SCRUB_ACCURACY_REPORT) {
      process.stdout.write(
        `${specialty}: caught ${caught}/${defects}, false blocks ${falseBlocks}/${clean}\n`,
      );
    }
    expect(caught / defects).toBeGreaterThanOrEqual(0.95);
    expect(falseBlocks / clean).toBeLessThanOrEqual(0.05);
  });
});
