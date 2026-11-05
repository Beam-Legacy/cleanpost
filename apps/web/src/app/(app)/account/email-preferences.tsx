'use client';
/** A-09 Email: switch the daily digest and urgent alert emails on or off for yourself. */
import { useState, useTransition } from 'react';
import { Switch, useToast } from '@cleanpost/ui';
import { saveEmailPreferences } from './email-actions';

export function EmailPreferences({
  digestEmail,
  alertEmail,
  isAdmin,
  digestTime,
}: {
  digestEmail: boolean;
  alertEmail: boolean;
  isAdmin: boolean;
  /** "7:30 am Pacific" */
  digestTime: string;
}) {
  const [v, setV] = useState({ digestEmail, alertEmail });
  const [pending, start] = useTransition();
  const toast = useToast();
  const save = (next: typeof v) => {
    setV(next);
    start(async () => {
      await saveEmailPreferences(next);
      toast({ message: 'Email settings saved.' });
    });
  };
  return (
    <div className="stack">
      <div className="stack-sm" style={{ gap: 2 }}>
        <Switch
          label="Daily digest"
          checked={v.digestEmail}
          disabled={pending}
          onCheckedChange={(on) => save({ ...v, digestEmail: on })}
        />
        <span className="subtle dense">
          Your queue and yesterday&apos;s results, each morning at {digestTime}.
        </span>
      </div>
      <div className="stack-sm" style={{ gap: 2 }}>
        <Switch
          label="Urgent alerts by email"
          checked={v.alertEmail}
          disabled={pending}
          onCheckedChange={(on) => save({ ...v, alertEmail: on })}
        />
        <span className="subtle dense">
          {isAdmin
            ? 'As an admin you still get connection-failed and timely-filing emails.'
            : 'Problems that cannot wait for the digest, sent right away.'}
        </span>
      </div>
      <span className="subtle dense">
        Emails never include patient information; they link into Cleanpost.
      </span>
    </div>
  );
}
