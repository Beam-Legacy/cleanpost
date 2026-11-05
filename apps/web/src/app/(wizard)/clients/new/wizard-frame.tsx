import type { ReactNode } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { LogoMark } from '@cleanpost/ui';
import { ONBOARDING_STEPS } from '@cleanpost/domain';
import { formatWhen } from '@/lib/format';

/**
 * O-01 to O-10 frame (ui/clients.html): header with the client and Save and exit, the step rail
 * (steps reached so far are links), and the step itself. Progress is saved by each step's action.
 */
export function WizardFrame({
  clientId,
  clientName,
  current,
  reached,
  savedAt,
  children,
}: {
  clientId: string | null;
  clientName: string | null;
  current: string;
  /** Furthest step reached, 1 to 10. */
  reached: number;
  savedAt: Date | null;
  children: ReactNode;
}) {
  const index = ONBOARDING_STEPS.findIndex((s) => s.key === current);
  return (
    <>
      <header className="wizard-head">
        <LogoMark />
        <b>Add client</b>
        {clientName && <span className="muted">{clientName}</span>}
        {savedAt && <span className="subtle">Saved {formatWhen(savedAt, new Date())}</span>}
        <Link href="/clients" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>
          Save and exit
        </Link>
      </header>
      <div className="wizard">
        <ol className="stepper" aria-label="Onboarding steps">
          {ONBOARDING_STEPS.map((s, i) => {
            const n = i + 1;
            const isCurrent = s.key === current;
            const done = !isCurrent && n < reached;
            const open = clientId && n <= reached && !isCurrent;
            const body = (
              <>
                <span className="n">{done ? <Check size={14} aria-label="Done" /> : n}</span>
                {s.label}
              </>
            );
            return (
              <li
                key={s.key}
                className={isCurrent ? 'current' : done ? 'done' : undefined}
                aria-current={isCurrent ? 'step' : undefined}
              >
                {open ? (
                  <Link className="stepper-link" href={`/clients/new/${s.key}?client=${clientId}`}>
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ol>
        <main className="stack-lg" style={{ maxWidth: 1040, minWidth: 0 }}>
          <span className="overline">
            Step {index + 1} of {ONBOARDING_STEPS.length}
          </span>
          {children}
        </main>
      </div>
    </>
  );
}

/** The step's heading and lead, as in the designs. */
export function StepHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="stack-sm" style={{ marginTop: -16 }}>
      <h1 className="display-m">{title}</h1>
      {children && (
        <p className="muted" style={{ maxWidth: 720, margin: 0 }}>
          {children}
        </p>
      )}
    </div>
  );
}
