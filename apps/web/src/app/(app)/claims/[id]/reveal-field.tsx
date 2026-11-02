'use client';
/** G-12 Reveal sensitive field: masked by default; each reveal and copy is audit-logged. */
import { Copy, Eye, EyeOff } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { IconButton, useToast } from '@cleanpost/ui';
import { revealField } from './actions';

export function RevealField({
  claimId,
  field,
  masked,
  label,
}: {
  claimId: string;
  field: 'dob' | 'member_id';
  masked: string;
  label: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  // Masks again after 30 seconds.
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setValue(null), 30_000);
    return () => clearTimeout(t);
  }, [value]);
  const fetchValue = (purpose: 'reveal' | 'copy') =>
    start(async () => {
      const res = await revealField(claimId, field, purpose);
      if (!res.ok) return toast({ message: res.message, tone: 'bad' });
      if (purpose === 'copy') {
        await navigator.clipboard?.writeText(res.value).catch(() => undefined);
        toast({ message: `${label} copied. The copy is recorded.` });
      } else setValue(res.value);
    });
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className="code" aria-live="polite">
        {value ?? masked}
      </span>
      {value ? (
        <IconButton label={`Hide ${label}`} icon={<EyeOff />} ghost onClick={() => setValue(null)} />
      ) : (
        <IconButton
          label={`Reveal ${label}`}
          icon={<Eye />}
          ghost
          disabled={pending}
          onClick={() => fetchValue('reveal')}
        />
      )}
      <IconButton
        label={`Copy ${label}`}
        icon={<Copy />}
        ghost
        disabled={pending}
        onClick={() => fetchValue('copy')}
      />
    </span>
  );
}
