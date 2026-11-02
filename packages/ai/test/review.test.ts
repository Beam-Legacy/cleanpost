import { describe, expect, it } from 'vitest';
import { createLogger } from '@cleanpost/log';
import { buildClaimPayload, npiFromBase, type Finding, type ScrubInput } from '@cleanpost/domain';
import { SYNTHETIC_MEMBER_ID_PATTERN, scanForPhi } from '@cleanpost/testing';
import {
  assertNoIdentifiers,
  CLAIM_REVIEW_SYSTEM,
  createBedrockReviewModel,
  createClaimReviewer,
  createStandInReviewModel,
  deidentifyClaim,
  DEFAULT_MODELS,
  type ReviewModel,
} from '../src';

const log = createLogger({ name: 'ai-test' });

function input(lines: { code: string; pointers?: number[] }[], dx = ['M17.11']): ScrubInput {
  const claim = buildClaimPayload(
    {
      id: 'enc',
      dateOfService: '2026-10-27',
      status: 'ready',
      pmStatus: 'Review',
      updatedAt: new Date(),
      renderingProvider: { id: 'p', npi: npiFromBase('193220441'), taxonomy: null },
      referringProviderNpi: null,
      location: { id: 'l', placeOfService: '11', npi: null },
      priorAuthNumber: 'PA1234567',
      diagnoses: dx.map((icd10, i) => ({ sequence: i + 1, icd10 })),
      lines: lines.map((l, i) => ({
        id: `cl${i}`,
        lineNumber: i + 1,
        code: l.code,
        modifiers: [],
        units: 1,
        chargeCents: 10_000,
        diagnosisPointers: l.pointers ?? [1],
        ndc: null,
      })),
    },
    {
      patientId: '01a00000-0000-7000-8000-00000000dead',
      coverage: { id: 'cov', payerId: 'payer', payerName: 'Aetna' },
      client: { billingNpi: npiFromBase('148772659'), taxonomy: null },
      timelyFilingDays: 120,
    },
  );
  return {
    clientId: 'c',
    claim,
    patient: { sex: 'F', ageYears: 47 },
    coverage: {
      id: 'cov',
      payerId: 'payer',
      payerName: 'Aetna',
      effectiveDate: '2024-01-01',
      terminationDate: null,
      memberIdPresent: true,
      relationship: 'self',
      subscriberPresent: false,
    },
    eligibility: null,
    reference: { icd10: null, procedures: null },
    ncci: [],
    mue: {},
    rules: [],
    history: { duplicates: [] },
    today: '2026-11-02',
  };
}

describe('de-identified claim view', () => {
  it('keeps codes, age, sex and the date of service, and nothing that identifies the patient', () => {
    const view = deidentifyClaim(input([{ code: '99213' }]), []);
    const text = JSON.stringify(view);
    expect(view.patient).toEqual({ ageYears: 47, sex: 'F' });
    expect(view.dateOfService).toBe('2026-10-27');
    expect(view.priorAuthOnFile).toBe(true);
    expect(text).not.toContain('PA1234567');
    expect(text).not.toContain('01a00000-0000-7000-8000-00000000dead');
    expect(() => assertNoIdentifiers(text)).not.toThrow();
  });

  it('refuses text shaped like an identifier', () => {
    for (const bad of [
      'SSN 123-45-6789',
      'call 503-555-0142',
      'a@b.org',
      'member XQ12345678',
      'born 1984-03-12',
    ]) {
      expect(() => assertNoIdentifiers(bad), bad).toThrow(/identifier/);
    }
    expect(SYNTHETIC_MEMBER_ID_PATTERN.test('XQ12345678')).toBe(true);
  });
});

describe('claim reviewer', () => {
  it('turns stand-in concerns into weightless warn findings on the ai step', async () => {
    const reviewer = createClaimReviewer({ model: createStandInReviewModel(), log });
    const review = await reviewer.review(
      input([{ code: '99215' }, { code: '20610', pointers: [1] }], ['Z00.00']),
      [],
    );
    expect(review!.concerns.length).toBeGreaterThanOrEqual(2);
    for (const c of review!.concerns) {
      expect(c).toMatchObject({ step: 'ai', severity: 'warn', weight: 0 });
      expect(c.ruleId).toMatch(/^ai\.claim-review-v1\.\d$/);
    }
    expect(review!.summary).toBe(`Looks ready apart from ${review!.concerns.length} points to check.`);
  });

  it('summarises the first block when the checks already block the claim', async () => {
    const reviewer = createClaimReviewer({ model: createStandInReviewModel(), log });
    const block: Finding = {
      ruleId: 'x',
      step: 'structural',
      severity: 'block',
      field: 'payer',
      message: 'Payer missing.',
    };
    const review = await reviewer.review(input([{ code: '99213' }]), [block]);
    expect(review!.summary).toBe('Blocked by 1 check: Payer missing.');
  });

  it('drops model output that looks like an identifier, and passes on a refusal', async () => {
    const leaky: ReviewModel = {
      name: 'leaky',
      reviewClaim: async () => ({
        model: 'leaky',
        inputTokens: 1,
        outputTokens: 1,
        output: {
          summary: 'Patient XQ12345678 looks fine.',
          concerns: [
            { field: 'lines[1]', message: 'Member XQ12345678 has a problem.', evidence: [] },
            { field: 'lines[1]', message: 'Check the modifier.', evidence: ['99213'] },
          ],
        },
      }),
    };
    const review = await createClaimReviewer({ model: leaky, log }).review(input([{ code: '99213' }]), []);
    expect(review!.summary).toBe('');
    expect(review!.concerns.map((c) => c.message)).toEqual(['Check the modifier.']);
    const refusing: ReviewModel = { name: 'r', reviewClaim: async () => null };
    expect(
      await createClaimReviewer({ model: refusing, log }).review(input([{ code: '99213' }]), []),
    ).toBeNull();
  });
});

describe('Bedrock review model', () => {
  type ParseArgs = {
    model: string;
    max_tokens: number;
    system: string;
    output_config: { effort: string; format: unknown };
    messages: { role: string; content: string }[];
  };

  function fakeClient(response: Record<string, unknown>) {
    const calls: ParseArgs[] = [];
    const client = {
      messages: {
        parse: async (args: ParseArgs) => {
          calls.push(args);
          return response;
        },
      },
    };
    return { client: client as never, calls };
  }

  it('sends the de-identified view with structured output to the routine model', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      model: DEFAULT_MODELS.routine,
      usage: { input_tokens: 812, output_tokens: 95 },
      parsed_output: { summary: 'Looks ready.', concerns: [] },
    });
    const model = createBedrockReviewModel({ client });
    const view = deidentifyClaim(input([{ code: '99213' }]), []);
    const res = await model.reviewClaim(view);
    expect(res).toMatchObject({ model: 'anthropic.claude-haiku-5-5', inputTokens: 812, outputTokens: 95 });
    expect(calls[0]).toMatchObject({
      model: 'anthropic.claude-haiku-5-5',
      max_tokens: 16_000,
      system: CLAIM_REVIEW_SYSTEM,
      output_config: { effort: 'low' },
    });
    expect(calls[0]!.output_config.format).toBeDefined();
    expect(JSON.parse(calls[0]!.messages[0]!.content)).toEqual(view);
    expect(scanForPhi(JSON.stringify(calls))).toEqual([]);
  });

  it('returns null on a refusal and throws when the output does not parse', async () => {
    const refused = createBedrockReviewModel({
      client: fakeClient({ stop_reason: 'refusal', parsed_output: null }).client,
    });
    expect(await refused.reviewClaim(deidentifyClaim(input([{ code: '99213' }]), []))).toBeNull();
    const broken = createBedrockReviewModel({
      client: fakeClient({ stop_reason: 'end_turn', parsed_output: null, usage: {} }).client,
    });
    await expect(broken.reviewClaim(deidentifyClaim(input([{ code: '99213' }]), []))).rejects.toThrow(
      /schema/,
    );
  });
});
