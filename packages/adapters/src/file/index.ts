/**
 * File adapter (level 3): charges arrive as CSV uploads (template in docs/15), 835 files from M3.
 * Files come from a FileSource (object storage in production; memory in tests). Pages are files, so
 * pulls are idempotent: the same `since` returns the same files in the same order.
 */
import type { AdapterKey, CapabilityMap, Connection, Operation, Page, PmAdapter } from '../contract';
import { OPERATIONS } from '../profiles';
import { manualTask } from '../results';
import { manualInstructions } from '../stub';
import { parseChargeCsv } from './charge-csv';
import { now as clockNow } from '@cleanpost/clock';

export interface StoredFile {
  id: string;
  receivedAt: Date;
  content: string;
}

export interface FileSource {
  /** Files of one kind for a connection, received at or after `since`, oldest first. */
  list(conn: Connection, kind: 'charges' | 'remittances', since: Date): Promise<StoredFile[]>;
}

export function memoryFileSource(
  files: Record<string, { kind: 'charges' | 'remittances'; file: StoredFile }[]>,
): FileSource {
  return {
    async list(conn, kind, since) {
      return (files[conn.id] ?? [])
        .filter((f) => f.kind === kind && f.file.receivedAt >= since)
        .map((f) => f.file)
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id));
    },
  };
}

const FILE_CAPS: CapabilityMap = {
  ...(Object.fromEntries(OPERATIONS.map((o) => [o, 0])) as CapabilityMap),
  pullPatientsAndCoverage: 3,
  pullCharges: 3,
  pullRemittances: 3,
  holdCharge: 'unavailable',
  releaseCharge: 'unavailable',
};

/** Cursor = index of the next file in the list for this `since`. */
async function pageFiles<T>(
  source: FileSource,
  conn: Connection,
  kind: 'charges' | 'remittances',
  since: Date,
  cursor: string | undefined,
  read: (f: StoredFile) => T[],
): Promise<Page<T>> {
  const files = await source.list(conn, kind, since);
  const index = cursor ? Number(cursor) : 0;
  const file = files[index];
  if (!file) return { items: [], nextCursor: null };
  return { items: read(file), nextCursor: index + 1 < files.length ? String(index + 1) : null };
}

export function createFileBackedAdapter(key: AdapterKey, pmName: string, source: FileSource): PmAdapter {
  const task = (op: Operation) => async () => {
    const { title, steps } = manualInstructions(pmName, op);
    return manualTask(op, title, steps);
  };
  return {
    key,
    syncPolicy: { defaultIntervalMinutes: 60, preferOffHours: false },
    capabilities: async () => FILE_CAPS,
    healthCheck: async () => ({ ok: true, checkedAt: clockNow(), details: {} }),
    // A patient can appear in many uploads: return each once, from the newest file it appears in.
    pullPatientsAndCoverage: async (conn, since, cursor) => {
      const files = await source.list(conn, 'charges', since);
      const index = cursor ? Number(cursor) : 0;
      const file = files[index];
      if (!file) return { items: [], nextCursor: null };
      const later = new Set(
        files
          .slice(index + 1)
          .flatMap((f) => parseChargeCsv(f.content, f.receivedAt).patients.map((p) => p.externalId)),
      );
      return {
        items: parseChargeCsv(file.content, file.receivedAt).patients.filter((p) => !later.has(p.externalId)),
        nextCursor: index + 1 < files.length ? String(index + 1) : null,
      };
    },
    pullCharges: (conn, since, cursor) =>
      pageFiles(
        source,
        conn,
        'charges',
        since,
        cursor,
        (f) => parseChargeCsv(f.content, f.receivedAt).encounters,
      ),
    // 835 parsing arrives with packages/x12 in M3; until then uploaded remittances wait.
    pullRemittances: async () => ({ items: [], nextCursor: null }),
    pullClaimsAndStatus: async () => ({ items: [], nextCursor: null }),
    pullPostings: async () => ({ items: [], nextCursor: null }),
    holdCharge: async () =>
      manualTask('holdCharge', 'Hold not available', [`${pmName} cannot hold charges.`]),
    releaseCharge: async () =>
      manualTask('releaseCharge', 'Release not available', [`${pmName} sends charges on its own schedule.`]),
    markChargeBilled: task('markChargeBilled'),
    pushChargeCorrection: task('pushChargeCorrection'),
    postPayment: task('postPayment'),
  };
}

export const createFileAdapter = (source: FileSource) => createFileBackedAdapter('file', 'the PM', source);
export { parseChargeCsv, CHARGE_CSV_COLUMNS } from './charge-csv';
