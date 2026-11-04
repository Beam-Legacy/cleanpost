/**
 * Confidence score and decision (docs/06-rules-and-ai.md):
 *
 *   start at 100; a block finding means blocked whatever the score; each warn minus its weight
 *   (default 15); each info minus 2; first claim for this client-payer pair minus 20; payer
 *   first-pass acceptance under 90% over 60 days minus 10; an AI concern minus 10; clamp 0..100.
 *   auto_release when nothing blocks and the score meets the effective threshold (below 100: 100
 *   means review everything), else review.
 */
import type { ScrubDecision } from '../state/claim';
import type { Finding } from './steps';
import { releasesWithoutReview } from './threshold';

export interface ConfidenceContext {
  /** Effective threshold (effectiveReleaseThreshold); 100 means review everything. */
  threshold: number;
  firstClaimForClientPayer: boolean;
  /** Share of this client's claims to this payer accepted first time over 60 days; null = not enough data. */
  payerFirstPassRate: number | null;
}

export interface Confidence {
  confidence: number;
  decision: ScrubDecision;
  /** Why the score is what it is, for C-03's breakdown. */
  deductions: { reason: string; points: number }[];
}

export function scoreClaim(findings: Finding[], ctx: ConfidenceContext): Confidence {
  const deductions: Confidence['deductions'] = [];
  for (const f of findings) {
    if (f.severity === 'warn') deductions.push({ reason: f.ruleId, points: f.weight ?? 15 });
    if (f.severity === 'info') deductions.push({ reason: f.ruleId, points: 2 });
  }
  if (ctx.firstClaimForClientPayer) deductions.push({ reason: 'first_claim_for_client_payer', points: 20 });
  if (ctx.payerFirstPassRate !== null && ctx.payerFirstPassRate < 0.9) {
    deductions.push({ reason: 'payer_first_pass_below_90', points: 10 });
  }
  if (findings.some((f) => f.step === 'ai')) deductions.push({ reason: 'ai_concern', points: 10 });
  const confidence = Math.max(0, Math.min(100, 100 - deductions.reduce((s, d) => s + d.points, 0)));
  const decision: ScrubDecision = findings.some((f) => f.severity === 'block')
    ? 'blocked'
    : releasesWithoutReview(confidence, ctx.threshold)
      ? 'auto_release'
      : 'review';
  return { confidence, decision, deductions };
}
