/**
 * Adapter registry: core code looks adapters up by key and never imports a PM module directly
 * (CLAUDE.md rule 3).
 */
import type { AdapterKey, PmAdapter } from './contract';
import { createFileAdapter, type FileSource } from './file';
import { createManualAdapter } from './manual';
import { createMockAdapter, type MockAdapterDeps } from './mock';
import { createStubAdapter } from './stub';
import { createTebraAdapter } from './tebra';

export interface RegistryDeps {
  fileSource: FileSource;
  /** The mock PM (local and preview only). Registered only when given. */
  mock?: Omit<MockAdapterDeps, 'fileSource'>;
  /** Extra adapters, e.g. test doubles. */
  extra?: PmAdapter[];
}

const STUBS: { key: AdapterKey; pmName: string }[] = [
  { key: 'athenaone', pmName: 'athenaOne' },
  { key: 'advancedmd', pmName: 'AdvancedMD' },
  { key: 'modmed', pmName: 'ModMed' },
  { key: 'simplepractice', pmName: 'SimplePractice' },
  { key: 'eclinicalworks', pmName: 'eClinicalWorks' },
  { key: 'drchrono', pmName: 'DrChrono' },
  { key: 'collaboratemd', pmName: 'CollaborateMD' },
  { key: 'officeally', pmName: 'Office Ally' },
  { key: 'nextgen_office', pmName: 'NextGen Office' },
];

export class AdapterRegistry {
  private readonly adapters = new Map<AdapterKey, PmAdapter>();

  register(adapter: PmAdapter): this {
    this.adapters.set(adapter.key, adapter);
    return this;
  }

  get(key: string): PmAdapter {
    const adapter = this.adapters.get(key as AdapterKey);
    if (!adapter) throw new Error(`No adapter registered for ${key}`);
    return adapter;
  }

  all(): PmAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createRegistry(deps: RegistryDeps): AdapterRegistry {
  const registry = new AdapterRegistry()
    .register(createManualAdapter(deps.fileSource))
    .register(createFileAdapter(deps.fileSource))
    .register(createTebraAdapter());
  for (const s of STUBS) registry.register(createStubAdapter(s));
  if (deps.mock) registry.register(createMockAdapter({ ...deps.mock, fileSource: deps.fileSource }));
  for (const a of deps.extra ?? []) registry.register(a);
  return registry;
}
