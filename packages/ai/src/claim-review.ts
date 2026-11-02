/**
 * Step 8 of the scrub: AI claim review (docs/06-rules-and-ai.md). The model reads a de-identified
 * claim and the deterministic findings, and returns structured concerns. Concerns become `warn`
 * findings and can never block; the model never sets a code, amount or status (CLAUDE.md rule 9).
 *
 * Logged per call: template, model, tokens, latency and the number of concerns. Never the prompt
 * or the model's text.
 */
import { z } from 'zod';
import type { Finding, ScrubInput } from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { assertNoIdentifiers, containsIdentifier, deidentifyClaim, type DeidentifiedClaim } from './redact';

export const CLAIM_REVIEW_TEMPLATE = 'claim-review-v1';

export const claimReviewOutputSchema = z.object({
  summary: z.string().max(600),
  concerns: z
    .array(
      z.object({
        /** Where the concern is: "lines[2]", "diagnoses", "placeOfService". */
        field: z.string().max(80),
        message: z.string().max(300),
        /** Codes or fields the concern rests on. */
        evidence: z.array(z.string().max(60)).max(5),
      }),
    )
    .max(5),
});
export type ClaimReviewOutput = z.infer<typeof claimReviewOutputSchema>;

export const CLAIM_REVIEW_SYSTEM = [
  'You review professional medical claims (837P) for a billing company before they go to the payer.',
  'You receive a de-identified claim (codes only, patient age and sex, no identifiers) and the findings',
  "that Cleanpost's deterministic checks already produced.",
  'Return concerns a careful certified coder would raise that the findings do not already cover, such as:',
  'diagnosis pointers that do not support the procedure on that line, an E/M level that looks high for',
  'the diagnoses billed, a missing or doubtful modifier, units that look unusual, or a place of service',
  'that does not fit the procedures.',
  'Rules: do not repeat a finding that is already listed. Refer to procedure codes by number only and never',
  'write their descriptions. Do not suggest codes that are not supported by the claim. If nothing stands',
  'out, return no concerns. Each message is one plain sentence for a biller.',
  'The summary is one or two plain sentences on whether the claim looks ready, mentioning the most',
  'important blocking finding if there is one.',
].join(' ');

export interface ReviewModelResult {
  output: ClaimReviewOutput;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The model call behind the reviewer: Bedrock in production, a stand-in in local and preview. */
export interface ReviewModel {
  readonly name: string;
  /** Returns null when the model declines (refusal); throws on transport errors. */
  reviewClaim(view: DeidentifiedClaim): Promise<ReviewModelResult | null>;
}

export interface ClaimReview {
  summary: string;
  concerns: Finding[];
}

/** Structurally the ClaimReviewer of @cleanpost/claims. */
export function createClaimReviewer(deps: { model: ReviewModel; log: Logger }) {
  return {
    async review(input: ScrubInput, findings: Finding[]): Promise<ClaimReview | null> {
      const view = deidentifyClaim(input, findings);
      assertNoIdentifiers(JSON.stringify(view));
      const started = Date.now();
      const result = await deps.model.reviewClaim(view);
      const latencyMs = Date.now() - started;
      if (!result) {
        deps.log.info(
          { template: CLAIM_REVIEW_TEMPLATE, model: deps.model.name, latencyMs },
          'AI review declined',
        );
        return null;
      }
      // Anything that looks like an identifier in the output is dropped, not shown.
      const concerns = result.output.concerns
        .filter((c) => !containsIdentifier(`${c.field} ${c.message} ${c.evidence.join(' ')}`))
        .map((c, i): Finding => ({
          ruleId: `ai.${CLAIM_REVIEW_TEMPLATE}.${i + 1}`,
          step: 'ai',
          severity: 'warn',
          field: c.field,
          message: c.message,
          evidence: c.evidence,
          // The confidence formula takes a flat 10 for any AI concern (docs/06), not per concern.
          weight: 0,
        }));
      const summary = containsIdentifier(result.output.summary) ? '' : result.output.summary;
      deps.log.info(
        {
          template: CLAIM_REVIEW_TEMPLATE,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs,
          concerns: concerns.length,
        },
        'AI review',
      );
      return { summary, concerns };
    },
  };
}
