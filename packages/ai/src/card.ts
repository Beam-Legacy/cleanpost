/**
 * Insurance card reading (docs/06, P-04): the fields printed on a card, each with how sure the
 * reader is. The model only reads; a person confirms (P-05, W-14) and deterministic code saves the
 * coverage. Bedrock runs only where synthetic data or a BAA covers it; the stand-in reads only the
 * synthetic cards Cleanpost's simulators make, which carry their own answer, and never guesses.
 */
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { records } from '@cleanpost/domain';
import { DEFAULT_MODELS } from './models';

export const CARD_FIELDS = [
  'payerName',
  'memberId',
  'groupNumber',
  'subscriberName',
  'planType',
  'rxBin',
  'payerPhone',
] as const;
export type CardField = (typeof CARD_FIELDS)[number];

const field = z.string().max(80).nullable();
export const cardReadingSchema = z.object({
  /** True when this is not a readable insurance card (blurred, cut off, another document). */
  unreadable: z.boolean(),
  fields: z.object({
    payerName: field,
    memberId: field,
    groupNumber: field,
    subscriberName: field,
    planType: field,
    rxBin: field,
    payerPhone: field,
  }),
  /** 0 to 1 for each field read; a field not on the card has none. */
  confidence: z.object({
    payerName: z.number().min(0).max(1).nullable(),
    memberId: z.number().min(0).max(1).nullable(),
    groupNumber: z.number().min(0).max(1).nullable(),
    subscriberName: z.number().min(0).max(1).nullable(),
    planType: z.number().min(0).max(1).nullable(),
    rxBin: z.number().min(0).max(1).nullable(),
    payerPhone: z.number().min(0).max(1).nullable(),
  }),
});
export type CardReading = z.infer<typeof cardReadingSchema>;

export interface CardImage {
  bytes: Uint8Array;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface CardReader {
  name: string;
  readCard(image: CardImage): Promise<CardReading>;
}

export const UNREADABLE: CardReading = {
  unreadable: true,
  fields: {
    payerName: null,
    memberId: null,
    groupNumber: null,
    subscriberName: null,
    planType: null,
    rxBin: null,
    payerPhone: null,
  },
  confidence: {
    payerName: null,
    memberId: null,
    groupNumber: null,
    subscriberName: null,
    planType: null,
    rxBin: null,
    payerPhone: null,
  },
};

export const CARD_READING_SYSTEM = `You read photos of US health insurance cards for a medical billing team.
Return each field exactly as printed, without correcting or completing it:
- payerName: the insurance company or plan name as printed (not the employer)
- memberId: the member or subscriber ID, with its letters and digits as printed
- groupNumber: the group number, if printed
- subscriberName: the subscriber or member name, as printed
- planType: the plan type (PPO, HMO, EPO, POS, Medicare Advantage...), if printed
- rxBin: the pharmacy RxBIN, if printed
- payerPhone: the customer service or provider phone number, if printed
A field that is not on the card is null. For each field you return, give a confidence from 0 to 1 that you read every character correctly; use low values for glare, blur, small print or partly hidden text.
If the image is not an insurance card or cannot be read, set unreadable to true and every field to null.`;

type ParseClient = Pick<AnthropicBedrockMantle, 'messages'>;

export function createBedrockCardReader(opts: {
  model?: string;
  awsRegion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests. */
  client?: ParseClient;
}): CardReader {
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
    async readCard(image: CardImage): Promise<CardReading> {
      const response = await client.messages.parse({
        model,
        max_tokens: 4_000,
        system: CARD_READING_SYSTEM,
        output_config: { effort: 'low', format: zodOutputFormat(cardReadingSchema) },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.contentType,
                  data: Buffer.from(image.bytes).toString('base64'),
                },
              },
              { type: 'text', text: 'Read this card.' },
            ],
          },
        ],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) return UNREADABLE;
      return response.parsed_output;
    },
  };
}

/**
 * Local and preview only: reads the answer a synthetic card carries. Any other image (a real photo
 * included) is unreadable, so the stand-in never pretends to read a real card.
 */
export function createStandInCardReader(): CardReader {
  return {
    name: 'stand-in',
    async readCard(image: CardImage): Promise<CardReading> {
      if (image.contentType !== 'image/png') return UNREADABLE;
      const raw = records.pngText(image.bytes).get(records.SYNTHETIC_CARD_KEYWORD);
      if (!raw) return UNREADABLE;
      try {
        const parsed = cardReadingSchema.safeParse({ unreadable: false, ...JSON.parse(raw) });
        return parsed.success ? parsed.data : UNREADABLE;
      } catch {
        return UNREADABLE;
      }
    },
  };
}
