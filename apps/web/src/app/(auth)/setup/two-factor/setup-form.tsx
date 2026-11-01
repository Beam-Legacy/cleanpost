'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Copy, Download } from 'lucide-react';
import QRCode from 'qrcode';
import { Button, Checkbox, Field, Input } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';
import { skipSecondFactorAction } from './actions';

type Step =
  | { kind: 'password' }
  | { kind: 'scan'; uri: string; key: string; qr: string; codes: string[] }
  | { kind: 'codes'; codes: string[] };

export function SetupForm({ canSkip }: { canSkip: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    const { data, error } = await authClient.twoFactor.enable({ password });
    if (error || !data || !('totpURI' in data)) return setError('That password is incorrect.');
    const key = new URL(data.totpURI).searchParams.get('secret') ?? '';
    const qr = await QRCode.toString(data.totpURI, { type: 'svg', margin: 0, width: 160 });
    setStep({ kind: 'scan', uri: data.totpURI, key, qr, codes: data.backupCodes });
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== 'scan') return;
    setError(null);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    if (error) return setError("That code didn't match. Enter the current code from your app.");
    setStep({ kind: 'codes', codes: step.codes });
  }

  async function addPasskey() {
    setError(null);
    const { error } = await authClient.passkey.addPasskey({ name: 'Cleanpost passkey' });
    if (error) return setError("The passkey wasn't added. Try again or use an authenticator app.");
    router.push('/work');
    router.refresh();
  }

  const intro = (
    <p className="muted">
      Cleanpost requires a second step at sign-in because it holds patient information. You can use an
      authenticator app such as 1Password, Google Authenticator or Microsoft Authenticator, or a passkey.
    </p>
  );

  // Preview only (PREVIEW_ALLOW_SKIP_2FA). The real product has no way past this step.
  const skip = canSkip ? (
    <form action={skipSecondFactorAction} className="callout stack-sm" style={{ marginTop: 16 }}>
      <span className="dense">
        <b>Preview only.</b> You can skip this step for now. In the real product two-factor sign-in can&apos;t
        be skipped.
      </span>
      <div>
        <Button type="submit">Skip for now</Button>
      </div>
    </form>
  ) : null;

  if (step.kind === 'password') {
    return (
      <>
        <form method="post" className="stack" onSubmit={start} noValidate>
          <span className="overline">Step 1 of 2</span>
          {intro}
          <Field label="Your password" help="Confirm it's you before we create your setup key." error={error}>
            {(p) => (
              <Input
                {...p}
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" block>
            Continue
          </Button>
          <Button variant="ghost" onClick={addPasskey}>
            Add a passkey instead
          </Button>
        </form>
        {skip}
      </>
    );
  }

  if (step.kind === 'scan') {
    return (
      <>
        <form method="post" className="stack" onSubmit={confirm} noValidate>
          <span className="overline">Step 1 of 2</span>
          {intro}
          <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
            <div
              role="img"
              aria-label="QR code for your authenticator app"
              style={{ width: 160, height: 160 }}
              dangerouslySetInnerHTML={{ __html: step.qr }}
            />
            <div className="stack-sm" style={{ flex: 1, minWidth: 200 }}>
              <span className="dense muted">Can&apos;t scan? Enter this key:</span>
              <span className="row">
                <code className="code">{step.key.match(/.{1,4}/g)?.join(' ')}</code>
                <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(step.key)}>
                  <Copy aria-hidden />
                  Copy key
                </Button>
              </span>
              <Field label="Code from the app" error={error}>
                {(p) => (
                  <Input
                    {...p}
                    name="code"
                    mono
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="6 digits"
                    required
                    autoFocus
                  />
                )}
              </Field>
              <Button type="submit" variant="primary">
                Confirm code
              </Button>
            </div>
          </div>
        </form>
        {skip}
      </>
    );
  }

  const text = step.codes.join('\n');
  return (
    <div className="stack">
      <span className="overline">Step 2 of 2 · Recovery codes</span>
      <p className="muted">
        Use one of these if you lose your phone. Each works once. Store them somewhere safe; we won&apos;t
        show them again.
      </p>
      <ul
        className="callout code"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 24px',
          listStyle: 'none',
          margin: 0,
        }}
      >
        {step.codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="row">
        <Button size="sm" onClick={() => download(text)}>
          <Download aria-hidden />
          Download
        </Button>
        <Button size="sm" onClick={() => navigator.clipboard.writeText(text)}>
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
      <Checkbox
        label="I saved these recovery codes"
        checked={saved}
        onChange={(e) => setSaved(e.currentTarget.checked)}
      />
      <Button
        variant="primary"
        size="lg"
        block
        disabled={!saved}
        onClick={() => {
          router.push('/work');
          router.refresh();
        }}
      >
        Continue
      </Button>
    </div>
  );
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: 'cleanpost-recovery-codes.txt',
  });
  a.click();
  URL.revokeObjectURL(url);
}
