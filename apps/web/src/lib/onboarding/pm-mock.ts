import 'server-only';
/**
 * O-04 in local and preview: make a practice in the mock PM for a client being onboarded, so the
 * whole flow (connect, test, dry run, go live, first sync) runs against a PM. The account's API key
 * is derived from PM_MOCK_SECRET the same way the worker's adapter derives it, so the connection
 * works without passing keys around. Refused anywhere else (there is no mock PM there).
 */
import { randomBytes } from 'node:crypto';
import { createDevSecretResolver } from '@cleanpost/adapters';

function mockPm(): { url: string; password: string; secret: string } | null {
  const env = process.env.CLEANPOST_ENV ?? 'local';
  if (env !== 'local' && env !== 'preview') return null;
  const url = process.env.PM_MOCK_URL?.replace(/\/$/, '');
  const password = process.env.PM_MOCK_ADMIN_PASSWORD;
  const secret = process.env.PM_MOCK_SECRET;
  return url && password && secret ? { url, password, secret } : null;
}

export function mockPmAvailable(): boolean {
  return mockPm() !== null;
}

export interface MockPracticeInput {
  name: string;
  profile: 'generic' | 'tebra' | 'managed_api';
  providers: { npi: string; name: string }[];
  locations: { name: string; placeOfService: string }[];
  payers: { name: string; kind: 'medicare' | 'medicaid' | 'commercial' }[];
}

export async function createMockPractice(
  input: MockPracticeInput,
): Promise<{ accountId: string; practiceId: string; locations: { id: string; name: string }[] }> {
  const pm = mockPm();
  if (!pm) throw new Error('mock PM not available here');
  const accountId = `acct-${randomBytes(4).toString('hex')}`;
  const apiKey = await createDevSecretResolver({ pmMockSecret: pm.secret }).resolve(`pm-mock:${accountId}`);
  const res = await fetch(`${pm.url}/admin/api/practices`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${pm.password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...input, accountId, apiKey, patients: 60, encounters: 120 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`mock PM refused the practice: ${res.status}`);
  return (await res.json()) as {
    accountId: string;
    practiceId: string;
    locations: { id: string; name: string }[];
  };
}
