import { describe, expect, it } from 'vitest';
import {
  describeCondition,
  describeOutcome,
  isRuleOff,
  ruleMatchesPayload,
  rulesOff,
  setRuleOff,
} from '../src';

/** S-06: the plain words come from the rule JSON the scrubber runs. */
describe('describing a rule', () => {
  it('turns a condition into a sentence, codes compacted into ranges', () => {
    expect(
      describeCondition({
        all: [
          { anyLine: { codeInGroup: 'em_office', modifierNotIn: ['25', '57'] } },
          { anyLine: { codeInGroup: 'minor_procedures' } },
        ],
      }),
    ).toBe(
      'a line has one of the office visit codes (99202–99205, 99211–99215) without modifier 25 or 57, and a line has one of the minor procedure codes (20600–20611, 20550–20553, 11102–11107, 11200, 17000, 17003, 17110, 69210, 10060–10061)',
    );
    expect(
      describeCondition(
        {
          all: [
            { field: 'payerId', eq: 'p1' },
            { field: 'priorAuthNumber', exists: false },
          ],
        },
        { payerName: (id) => (id === 'p1' ? 'Cigna' : undefined) },
      ),
    ).toBe('the payer is Cigna, and the prior authorization number is missing');
    expect(describeCondition({ noLine: { codeIn: ['99213'], unitsGt: 1 } })).toBe(
      'no line has code 99213 for more than 1 unit',
    );
  });

  it('says what the rule does, including the fix and the confidence cost', () => {
    expect(
      describeOutcome({
        kind: 'validate',
        severity: 'warn',
        weight: 15,
        action: {
          finding: 'Add modifier 25 to the visit line.',
          suggestedFix: { op: 'addModifier', modifier: '25', lineMatch: { codeInGroup: 'em_established' } },
        },
      }),
    ).toEqual([
      'Flag a warning: "Add modifier 25 to the visit line."',
      'Suggest the fix: add modifier 25 to the line with one of the established-patient visit codes (99211–99215).',
      'Lower confidence by 15.',
    ]);
    expect(
      describeOutcome({
        kind: 'validate',
        severity: 'block',
        weight: 15,
        action: { finding: 'Stop.' },
      }),
    ).toEqual(['Stop the claim for a fix: "Stop."', 'A blocked claim always waits for a person.']);
  });
});

describe('switching a built-in rule off for a company or a client (S-05)', () => {
  it('reads the list from settings, applies company-wide or per client, and switches back on', () => {
    const off = rulesOff({ rulesOff: [{ ruleId: 'seed.coding.laterality', clientId: null }, { bad: 1 }] });
    expect(off).toEqual([{ ruleId: 'seed.coding.laterality', clientId: null }]);
    expect(isRuleOff(off, 'seed.coding.laterality', 'any-client')).toBe(true);
    const one = setRuleOff([], 'seed.payer.prior_auth_common', 'c1', true);
    expect(isRuleOff(one, 'seed.payer.prior_auth_common', 'c1')).toBe(true);
    expect(isRuleOff(one, 'seed.payer.prior_auth_common', 'c2')).toBe(false);
    expect(setRuleOff(one, 'seed.payer.prior_auth_common', 'c1', false)).toEqual([]);
    expect(rulesOff(null)).toEqual([]);
  });

  it('tests a rule against a claim as billed', () => {
    const payload = {
      payerId: 'p1',
      facility: null,
      priorAuthNumber: null,
      diagnoses: [{ sequence: 1, icd10: 'M25.561' }],
      lines: [{ lineNumber: 1, code: '29881', modifiers: [], units: 1 }],
    } as unknown as Parameters<typeof ruleMatchesPayload>[1];
    const priorAuth = {
      condition: {
        all: [
          { anyLine: { codeInGroup: 'prior_auth_common' } },
          { field: 'priorAuthNumber' as const, exists: false },
        ],
      },
    };
    expect(ruleMatchesPayload(priorAuth, payload)).toBe(true);
    expect(ruleMatchesPayload(priorAuth, { ...payload, priorAuthNumber: 'A123' })).toBe(false);
  });
});
