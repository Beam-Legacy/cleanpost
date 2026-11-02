'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const selectStyle = {
  border: 0,
  background: 'transparent',
  font: 'inherit',
  fontWeight: 600,
  width: 'auto',
  maxWidth: 200,
} as const;

/** C-01 filters: payer and status. The client comes from the top bar's switcher (G-02). */
export function ClaimFilterSelects({
  payers,
  statuses,
}: {
  payers: { id: string; name: string }[];
  statuses: [string, string][];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };
  return (
    <>
      <label className="filter-select">
        Payer:{' '}
        <select
          aria-label="Payer"
          value={params.get('payer') ?? ''}
          onChange={(e) => set('payer', e.target.value)}
          style={selectStyle}
        >
          <option value="">Any</option>
          {payers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-select">
        Status:{' '}
        <select
          aria-label="Status"
          value={params.get('status') ?? ''}
          onChange={(e) => set('status', e.target.value)}
          style={selectStyle}
        >
          <option value="">Any in this view</option>
          {statuses.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
