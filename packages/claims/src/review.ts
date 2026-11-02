/**
 * Step 8 of the scrub: the AI review (docs/06-rules-and-ai.md). The implementation lives in
 * @cleanpost/ai, which builds the de-identified view itself; the scrub only sees structured output.
 */
import type { Finding, ScrubInput } from '@cleanpost/domain';

export interface ClaimReview {
  /** Plain-language summary for the biller. */
  summary: string;
  /** Concerns become `warn` findings (step `ai`); they never block on their own. */
  concerns: Finding[];
}

export interface ClaimReviewer {
  review(input: ScrubInput, findings: Finding[]): Promise<ClaimReview | null>;
}
