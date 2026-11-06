import { describe, expect, it } from 'vitest';
import { records } from '@cleanpost/domain';
import { createBedrockCardReader, createStandInCardReader, UNREADABLE, type CardReading } from '../src';

/** A 1x1 PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const READING: CardReading = {
  unreadable: false,
  fields: {
    payerName: 'Cigna',
    memberId: 'U4417 7093',
    groupNumber: '3341870',
    subscriberName: 'Ana Rivera',
    planType: 'PPO',
    rxBin: '017010',
    payerPhone: '800-555-0199',
  },
  confidence: {
    payerName: 0.98,
    memberId: 0.96,
    groupNumber: 0.82,
    subscriberName: 0.97,
    planType: 0.95,
    rxBin: 0.93,
    payerPhone: 0.94,
  },
};

describe('card reading (P-04)', () => {
  it('the stand-in reads only a synthetic card that carries its answer', async () => {
    const reader = createStandInCardReader();
    const card = records.addPngText(
      PNG,
      records.SYNTHETIC_CARD_KEYWORD,
      records.asciiJson({ fields: READING.fields, confidence: READING.confidence }),
    );
    expect(await reader.readCard({ bytes: card, contentType: 'image/png' })).toEqual(READING);
    // A real photo, or anything else, is unreadable: the stand-in never guesses.
    expect(await reader.readCard({ bytes: PNG, contentType: 'image/png' })).toEqual(UNREADABLE);
    expect(await reader.readCard({ bytes: card, contentType: 'image/jpeg' })).toEqual(UNREADABLE);
    const broken = records.addPngText(PNG, records.SYNTHETIC_CARD_KEYWORD, '{"fields":');
    expect(await reader.readCard({ bytes: broken, contentType: 'image/png' })).toEqual(UNREADABLE);
  });

  it('Bedrock gets the image and the reading instructions, and a refusal reads as unreadable', async () => {
    const calls: { content: unknown[] }[] = [];
    const client = (out: { stop_reason: string; parsed_output: CardReading | null }) => ({
      messages: {
        parse: async (args: { messages: { content: unknown[] }[] }) => {
          calls.push(args.messages[0]!);
          return out;
        },
      },
    });
    const reader = createBedrockCardReader({
      client: client({ stop_reason: 'end_turn', parsed_output: READING }) as never,
    });
    expect(await reader.readCard({ bytes: PNG, contentType: 'image/png' })).toEqual(READING);
    expect(calls[0]!.content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    const refused = createBedrockCardReader({
      client: client({ stop_reason: 'refusal', parsed_output: null }) as never,
    });
    expect(await refused.readCard({ bytes: PNG, contentType: 'image/png' })).toEqual(UNREADABLE);
  });
});
