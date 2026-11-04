'use client';
/**
 * Local and preview with email off (inviteLinksShown): the invite links S-02 would have emailed, to
 * copy and pass on by hand. Staging and production never return them.
 */
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Banner, Button } from '@cleanpost/ui';

export function InviteLinks({ links }: { links: { email: string; url: string }[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="stack-sm">
      <Banner>
        Email is off here. Open each link in a private window (or another browser) to accept as that
        person.
      </Banner>
      {links.map((l, i) => (
        <div key={l.email} className="field">
          <label htmlFor={`invite-link-${i}`}>Invite link for {l.email}</label>
          <span className="row dense" style={{ gap: 6 }}>
            <input
              id={`invite-link-${i}`}
              className="input mono"
              readOnly
              value={l.url}
              onFocus={(e) => e.currentTarget.select()}
              style={{ flex: 1, minWidth: 0 }}
            />
            <Button size="sm" onClick={() => void copy(l.url)}>
              <Copy aria-hidden />
              {copied === l.url ? 'Copied' : 'Copy'}
              <span className="sr-only"> link for {l.email}</span>
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}
