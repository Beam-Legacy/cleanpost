/**
 * A 271 in the shape of Stedi's real-time eligibility JSON (POST
 * /2024-04-01/change/medicalnetwork/eligibility/v3), answered from the payer's member file, so the
 * same Cleanpost client works against payer-sim now and against Stedi when the key arrives.
 *
 * Codes from X12 271 as Stedi passes them through: benefitsInformation code 1 Active Coverage,
 * 6 Inactive, B Co-Payment, C Deductible, A Co-Insurance; AAA 72 Invalid/Missing Subscriber ID,
 * 75 Subscriber Not Found. Verify against the Stedi sandbox (docs/15-integrations-reference.md).
 */
import { z } from 'zod';

export const eligibilityRequestSchema = z.object({
  controlNumber: z.string().min(1).max(9).optional(),
  tradingPartnerServiceId: z.string().min(1),
  provider: z.object({ organizationName: z.string().optional(), npi: z.string().optional() }),
  subscriber: z.object({
    memberId: z.string().optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{8}$/)
      .optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  }),
  encounter: z
    .object({
      dateOfService: z
        .string()
        .regex(/^\d{8}$/)
        .optional(),
      serviceTypeCodes: z.array(z.string()).optional(),
    })
    .optional(),
});
export type EligibilityRequest = z.infer<typeof eligibilityRequestSchema>;

export interface MemberRow {
  status: string;
  dateOfBirth: string;
  planBegin: string | null;
  planEnd: string | null;
  copayCents: number | null;
  deductibleRemainingCents: number | null;
  coinsurancePercent: number | null;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** The 271 for one request, given the member row the payer found (or none). */
export function respond271(req: EligibilityRequest, member: MemberRow | null) {
  const base = {
    controlNumber: req.controlNumber ?? '000000001',
    tradingPartnerServiceId: req.tradingPartnerServiceId,
    provider: req.provider,
  };
  const dob = req.subscriber.dateOfBirth;
  if (!req.subscriber.memberId) {
    return {
      ...base,
      subscriber: req.subscriber,
      errors: [
        {
          code: '72',
          description: 'Invalid/Missing Subscriber/Insured ID',
          field: 'AAA',
          followupAction: 'Please Correct and Resubmit',
          location: 'Loop 2100C',
        },
      ],
    };
  }
  if (!member || (dob && member.dateOfBirth !== dob)) {
    return {
      ...base,
      subscriber: req.subscriber,
      errors: [
        {
          code: '75',
          description: 'Subscriber/Insured Not Found',
          field: 'AAA',
          followupAction: 'Please Correct and Resubmit',
          location: 'Loop 2100C',
        },
      ],
    };
  }
  const dos = req.encounter?.dateOfService ?? null;
  const inPlan =
    member.status === 'active' &&
    (!dos || ((!member.planBegin || member.planBegin <= dos) && (!member.planEnd || member.planEnd >= dos)));
  const stc = req.encounter?.serviceTypeCodes ?? ['30'];
  const benefits: Record<string, unknown>[] = [
    inPlan
      ? { code: '1', name: 'Active Coverage', serviceTypeCodes: stc, coverageLevelCode: 'IND' }
      : { code: '6', name: 'Inactive', serviceTypeCodes: stc },
  ];
  if (inPlan && member.copayCents !== null)
    benefits.push({
      code: 'B',
      name: 'Co-Payment',
      serviceTypeCodes: ['98'],
      benefitAmount: dollars(member.copayCents),
      inPlanNetworkIndicatorCode: 'Y',
    });
  if (inPlan && member.deductibleRemainingCents !== null)
    benefits.push({
      code: 'C',
      name: 'Deductible',
      serviceTypeCodes: ['30'],
      timeQualifierCode: '29',
      benefitAmount: dollars(member.deductibleRemainingCents),
      inPlanNetworkIndicatorCode: 'Y',
    });
  if (inPlan && member.coinsurancePercent !== null)
    benefits.push({
      code: 'A',
      name: 'Co-Insurance',
      serviceTypeCodes: ['30'],
      benefitPercent: (member.coinsurancePercent / 100).toFixed(2),
      inPlanNetworkIndicatorCode: 'Y',
    });
  return {
    ...base,
    subscriber: { memberId: req.subscriber.memberId, dateOfBirth: member.dateOfBirth },
    planStatus: [
      inPlan
        ? { statusCode: '1', status: 'Active Coverage', serviceTypeCodes: stc }
        : { statusCode: '6', status: 'Inactive', serviceTypeCodes: stc },
    ],
    planDateInformation: {
      ...(member.planBegin ? { planBegin: member.planBegin } : {}),
      ...(member.planEnd ? { planEnd: member.planEnd } : {}),
    },
    benefitsInformation: benefits,
  };
}

export const memberRosterSchema = z.object({
  members: z
    .array(
      z.object({
        payerId: z.string().min(1),
        memberId: z.string().min(1),
        dateOfBirth: z.string().regex(/^\d{8}$/),
        status: z.enum(['active', 'inactive']),
        planBegin: z
          .string()
          .regex(/^\d{8}$/)
          .nullable()
          .optional(),
        planEnd: z
          .string()
          .regex(/^\d{8}$/)
          .nullable()
          .optional(),
        copayCents: z.number().int().nullable().optional(),
        deductibleRemainingCents: z.number().int().nullable().optional(),
        coinsurancePercent: z.number().int().min(0).max(100).nullable().optional(),
      }),
    )
    .max(5000),
});
