/**
 * Manual adapter (docs/05-adapters.md): no integration at all. Charges come in as uploaded files;
 * every action becomes a manual task with PM-specific instructions where known.
 */
import type { FileSource } from '../file';
import { createFileBackedAdapter } from '../file';

export const createManualAdapter = (source: FileSource, pmName = 'the PM') =>
  createFileBackedAdapter('manual', pmName, source);
