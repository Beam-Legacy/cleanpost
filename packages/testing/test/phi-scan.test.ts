import { describe, expect, it } from 'vitest';
import { scanForPhi, syntheticMemberId } from '../src';

describe('scanForPhi', () => {
  it('finds synthetic names, member IDs and dates of birth', () => {
    const text = [
      '{"level":30,"msg":"claim built","claimId":"0192f3a0"}',
      '{"msg":"patient Nguyen updated"}',
      `{"memberId":"${syntheticMemberId(42)}"}`,
      '{"dob":"1984-03-12"}',
    ].join('\n');
    expect(scanForPhi(text)).toEqual([
      { kind: 'synthetic_name', line: 2, match: 'Nguyen' },
      { kind: 'member_id', line: 3, match: 'XQ00000042' },
      { kind: 'date_of_birth', line: 4, match: '1984-03-12' },
    ]);
  });

  it('ignores IDs, dates of service and timestamps', () => {
    const text =
      '{"time":"2026-10-29T14:02:11.120Z","dos":"2026-10-27","claimId":"0192f3a0-7c1e-7000-8000-000000000001"}';
    expect(scanForPhi(text)).toEqual([]);
  });

  it('matches whole words only', () => {
    expect(scanForPhi('heart rate, hartford, Hartley')).toEqual([]);
  });
});
