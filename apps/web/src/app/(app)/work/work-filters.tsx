'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** W-01 filter selects: payer and assignee. The client comes from the top bar's switcher (G-02). */
export function WorkFilterSelects({ payers }: { payers: { id: string; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete('item');
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
          style={{
            border: 0,
            background: 'transparent',
            font: 'inherit',
            fontWeight: 600,
            width: 'auto',
            maxWidth: 200,
          }}
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
        Assignee:{' '}
        <select
          aria-label="Assignee"
          value={params.get('assignee') ?? ''}
          onChange={(e) => set('assignee', e.target.value)}
          style={{
            border: 0,
            background: 'transparent',
            font: 'inherit',
            fontWeight: 600,
            width: 'auto',
            maxWidth: 200,
          }}
        >
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
        </select>
      </label>
    </>
  );
}
