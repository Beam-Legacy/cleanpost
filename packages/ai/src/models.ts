/**
 * Review models. Bedrock (Claude, through the Anthropic SDK's Bedrock Mantle client) is the real
 * one and runs only where synthetic data or a BAA covers it (CLAUDE.md). The stand-in gives the
 * same structured output from fixed heuristics, so local and preview work without AWS credentials.
 */
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CODE_GROUPS } from '@cleanpost/domain';
import {
  CLAIM_REVIEW_SYSTEM,
  claimReviewOutputSchema,
  type ClaimReviewOutput,
  type ReviewModel,
  type ReviewModelResult,
} from './claim-review';
import type { DeidentifiedClaim } from './redact';

/** Model routing (docs/06): a smaller model for routine review, a larger one for denials and rules. */
export const DEFAULT_MODELS = {
  routine: 'anthropic.claude-haiku-5-5',
  large: 'anthropic.claude-opus-5-5',
} as const;

type ParseClient = Pick<AnthropicBedrockMantle, 'messages'>;

export function createBedrockReviewModel(opts: {
  model?: string;
  awsRegion?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Per attempt, in milliseconds. The SDK retries 429, 5xx and connection errors. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests. */
  client?: ParseClient;
}): ReviewModel {
  const model = opts.model ?? DEFAULT_MODELS.routine;
  const client =
    opts.client ??
    new AnthropicBedrockMantle({
      ...(opts.awsRegion ? { awsRegion: opts.awsRegion } : {}),
      timeout: opts.timeoutMs ?? 30_000,
      maxRetries: opts.maxRetries ?? 2,
    });
  return {
    name: model,
    async reviewClaim(view: DeidentifiedClaim): Promise<ReviewModelResult | null> {
      const response = await client.messages.parse({
        model,
        max_tokens: 16_000,
        system: CLAIM_REVIEW_SYSTEM,
        // Routine review is closer to classification than reasoning: low effort holds quality here.
        output_config: { effort: opts.effort ?? 'low', format: zodOutputFormat(claimReviewOutputSchema) },
        messages: [{ role: 'user', content: JSON.stringify(view) }],
      });
      if (response.stop_reason === 'refusal') return null;
      if (!response.parsed_output) throw new Error('AI review output did not match the schema');
      return {
        output: response.parsed_output,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}

const EM = new Set([...(CODE_GROUPS.em_office ?? [])]);
const NOT_PROCEDURES = new Set([
  ...(CODE_GROUPS.em_office ?? []),
  ...(CODE_GROUPS.em_preventive ?? []),
  ...(CODE_GROUPS.vaccine_admin ?? []),
]);

/** Fixed heuristics with the review's output shape. Not a model; never sent anywhere. */
export function createStandInReviewModel(): ReviewModel {
  return {
    name: 'stand-in',
    async reviewClaim(view: DeidentifiedClaim): Promise<ReviewModelResult> {
      const concerns: ClaimReviewOutput['concerns'] = [];
      for (const l of view.lines) {
        if ((l.code === '99215' || l.code === '99205') && view.diagnoses.length <= 1 && EM.has(l.code)) {
          concerns.push({
            field: `lines[${l.line}]`,
            message: `Line ${l.line} bills a high-level visit with one diagnosis; check the documentation supports the level.`,
            evidence: [l.code, `${view.diagnoses.length} diagnosis`],
          });
        }
        const pointed = l.pointers.map((p) => view.diagnoses[p - 1]).filter((d): d is string => Boolean(d));
        if (!NOT_PROCEDURES.has(l.code) && pointed.length > 0 && pointed.every((d) => d.startsWith('Z'))) {
          concerns.push({
            field: `lines[${l.line}].dxPointers`,
            message: `Line ${l.line} points only to screening or encounter diagnoses; payers often deny a procedure without a supporting diagnosis.`,
            evidence: [l.code, ...pointed],
          });
        }
      }
      const blocks = view.findingsSoFar.filter((f) => f.severity === 'block');
      const summary = blocks.length
        ? `Blocked by ${blocks.length} check${blocks.length === 1 ? '' : 's'}: ${blocks[0]!.message}`
        : concerns.length
          ? `Looks ready apart from ${concerns.length} point${concerns.length === 1 ? '' : 's'} to check.`
          : 'No problems found by the checks.';
      return {
        output: claimReviewOutputSchema.parse({
          summary: summary.slice(0, 600),
          concerns: concerns.slice(0, 5),
        }),
        model: 'stand-in',
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
}
