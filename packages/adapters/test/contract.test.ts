import { adapterContract } from '../src/testing/contract-suite';
import { createRegistry, memoryFileSource } from '../src';
import { CHARGE_CSV, conn } from './fixtures';

const since = new Date('2026-10-01T00:00:00Z');
const fileConn = conn('file');
const manualConn = conn('manual', '01a00000-0000-7000-8000-00000000c002');
const files = memoryFileSource({
  [fileConn.id]: [
    {
      kind: 'charges',
      file: { id: 'f1', receivedAt: new Date('2026-10-28T10:00:00Z'), content: CHARGE_CSV },
    },
    {
      kind: 'charges',
      file: {
        id: 'f2',
        receivedAt: new Date('2026-10-29T10:00:00Z'),
        content: CHARGE_CSV.replace(/E1002/g, 'E2002'),
      },
    },
  ],
  [manualConn.id]: [
    {
      kind: 'charges',
      file: { id: 'm1', receivedAt: new Date('2026-10-28T10:00:00Z'), content: CHARGE_CSV },
    },
  ],
});
const registry = createRegistry({ fileSource: files });

for (const adapter of registry.all()) {
  const c = adapter.key === 'file' ? fileConn : adapter.key === 'manual' ? manualConn : conn(adapter.key);
  adapterContract(adapter.key, async () => ({ adapter, conn: c, since, sampleEncounterId: 'E10021' }));
}
