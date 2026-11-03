'use client';
/** RP-01 date range: presets as a plain list (this month, last month, last 30 and 90 days). */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Select } from '@cleanpost/ui';
import { PERIOD_OPTIONS } from '@/lib/report-display';

export function PeriodPicker({ value }: { value: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <label className="row dense" style={{ gap: 6, whiteSpace: 'nowrap' }}>
      <span className="muted">Period</span>
      <Select
        style={{ width: 'auto' }}
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          next.set('period', e.target.value);
          router.push(`${path}?${next.toString()}`, { scroll: false });
        }}
      >
        {PERIOD_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
