'use client';
/**
 * S-12 form: sign-in, sessions, network and exports, with one Save. Save asks for the second factor
 * when it was last entered more than 10 minutes ago (step-up): the authenticator code, or the
 * passkey for someone who has no authenticator app.
 */
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Fingerprint, Lock } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Switch, Textarea, useToast } from '@cleanpost/ui';
import { company } from '@cleanpost/domain';
import { authClient } from '@/lib/auth-client';
import { resumeCompanyAction, saveSecuritySettings, type SecurityInput } from './actions';

const EXPORTS: Record<company.PatientExports, string> = {
  admins: 'Owner and admins',
  owner: 'Owner only',
  nobody: 'Nobody',
};

export function SecurityForm({
  settings,
  passkeyOnly,
  stepUpWith,
  address,
  tenantId,
}: {
  settings: company.SecuritySettings;
  passkeyOnly: number;
  stepUpWith: 'code' | 'passkey';
  address: string | null;
  tenantId: string;
}) {
  const [v, setV] = useState({
    allowPasskeys: settings.allowPasskeys,
    trustedDevices: settings.trustedDevices,
    idleMinutes: settings.idleMinutes as number,
    absoluteHours: settings.absoluteHours as number,
    allowlistText: settings.ipAllowlist.join('\n'),
    patientExports: settings.patientExports as string,
  });
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const code = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const router = useRouter();

  const save = (input: SecurityInput = v) =>
    start(async () => {
      const res = await saveSecuritySettings(input);
      setAllowlistError(!res.ok && res.field === 'allowlist' ? res.message : null);
      if (!res.ok && res.stepUp) {
        setStepUpError(null);
        setStepUp(true);
        return;
      }
      if (!res.ok && res.field === 'allowlist') return;
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) router.refresh();
    });

  const confirmWithCode = (value: string) =>
    start(async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code: value });
      if (error) {
        setStepUpError("That code didn't match. Enter the current code from your app.");
        if (code.current) code.current.value = '';
        return;
      }
      setStepUp(false);
      save();
    });

  const confirmWithPasskey = () =>
    start(async () => {
      const { error } = await authClient.signIn.passkey();
      if (error || !(await resumeCompanyAction(tenantId))) {
        setStepUpError("That passkey didn't work. Try again.");
        return;
      }
      setStepUp(false);
      save();
    });

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="row-between">
        <div>
          <h2 className="title-m">Security</h2>
          <p className="muted dense" style={{ margin: 0 }}>
            Sign-in, sessions and data export controls
          </p>
        </div>
        <Button type="submit" size="sm" variant="primary" disabled={pending} aria-busy={pending}>
          Save
        </Button>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Sign-in</h3>
        </div>
        <div className="card-body stack-sm">
          <div className="row-between">
            <div>
              <b className="dense">Two-factor sign-in</b>
              <p className="subtle" style={{ margin: 0 }}>
                Required for every user. Cannot be turned off.
              </p>
            </div>
            <span className="chip chip-good">
              <Lock aria-hidden />
              Required
            </span>
          </div>
          <hr className="divider" />
          <div className="stack-sm">
            <Switch
              label="Allow passkeys"
              checked={v.allowPasskeys}
              onCheckedChange={(c) => setV((s) => ({ ...s, allowPasskeys: c }))}
            />
            <p className="subtle" style={{ margin: 0 }}>
              Users can sign in with a device passkey instead of an authenticator code.
              {!v.allowPasskeys && passkeyOnly > 0 && (
                <>
                  {' '}
                  <b>
                    {passkeyOnly} {passkeyOnly === 1 ? 'person signs' : 'people sign'} in with a passkey only
                    and will need an authenticator app (reset their two-factor sign-in in Users and roles).
                  </b>
                </>
              )}
            </p>
          </div>
          <hr className="divider" />
          <div className="stack-sm">
            <Switch
              label="Trusted devices"
              checked={v.trustedDevices}
              onCheckedChange={(c) => setV((s) => ({ ...s, trustedDevices: c }))}
            />
            <p className="subtle" style={{ margin: 0 }}>
              Skip the second step for {company.TRUSTED_DEVICE_HOURS} hours on devices a user marks as
              trusted. Offered only to people whose every company allows it.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Sessions</h3>
        </div>
        <div className="card-body form-grid">
          <Field label="Sign out after inactivity">
            {(p) => (
              <Select
                {...p}
                value={v.idleMinutes}
                onChange={(e) => {
                  const n = Number(e.currentTarget.value);
                  setV((s) => ({ ...s, idleMinutes: n }));
                }}
              >
                {company.IDLE_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Maximum session length" help="Then everyone signs in again, active or not.">
            {(p) => (
              <Select
                {...p}
                value={v.absoluteHours}
                onChange={(e) => {
                  const n = Number(e.currentTarget.value);
                  setV((s) => ({ ...s, absoluteHours: n }));
                }}
              >
                {company.ABSOLUTE_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h} hours
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Network</h3>
        </div>
        <div className="card-body stack-sm">
          <Field
            label="Allowed IP addresses"
            error={allowlistError}
            help={`Leave empty to allow sign-in from anywhere.${
              address ? ` Your current address is ${address}.` : ''
            }`}
          >
            {(p) => (
              <Textarea
                {...p}
                className="input mono"
                rows={4}
                placeholder="One address or range per line, e.g. 203.0.113.0/24"
                value={v.allowlistText}
                onChange={(e) => {
                  const text = e.currentTarget.value;
                  setV((s) => ({ ...s, allowlistText: text }));
                }}
              />
            )}
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Exports</h3>
        </div>
        <div className="card-body stack-sm">
          <div className="row-between" style={{ gap: 16 }}>
            <div>
              <b className="dense">Patient-level exports</b>
              <p className="subtle" style={{ margin: 0 }}>
                CSV exports that include patient names or IDs. Always watermarked and recorded in the audit
                log.
              </p>
            </div>
            <Select
              aria-label="Who can export patient-level data"
              style={{ width: 200 }}
              value={v.patientExports}
              onChange={(e) => {
                const who = e.currentTarget.value;
                setV((s) => ({ ...s, patientExports: who }));
              }}
            >
              {company.PATIENT_EXPORTS.map((w) => (
                <option key={w} value={w}>
                  {EXPORTS[w]}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      <Modal
        open={stepUp}
        onOpenChange={setStepUp}
        title="Confirm it's you"
        description="Security settings change how everyone signs in, so they need your second sign-in step again."
        size="sm"
      >
        {stepUpWith === 'code' ? (
          <form
            className="stack"
            onSubmit={(e) => {
              // The dialog is in a portal, but React still bubbles its submit to the page's form.
              e.preventDefault();
              e.stopPropagation();
              confirmWithCode(String(new FormData(e.currentTarget).get('code') ?? '').trim());
            }}
          >
            <Field label="Code from your authenticator app" error={stepUpError}>
              {(p) => (
                <Input
                  {...p}
                  ref={code}
                  name="code"
                  mono
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" block disabled={pending} aria-busy={pending}>
              Confirm and save
            </Button>
          </form>
        ) : (
          <div className="stack">
            {stepUpError && (
              <span className="error" role="alert">
                {stepUpError}
              </span>
            )}
            <Button
              variant="primary"
              block
              onClick={confirmWithPasskey}
              disabled={pending}
              aria-busy={pending}
            >
              <Fingerprint aria-hidden />
              Confirm with your passkey and save
            </Button>
          </div>
        )}
      </Modal>
    </form>
  );
}
