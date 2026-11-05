'use client';
/** O-01 Practice: the billing provider details that go on every claim. */
import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { isValidNpi } from '@cleanpost/domain';
import { Button } from '@cleanpost/ui';
import { TIME_ZONES } from '@/lib/onboarding/options';
import { savePracticeAction, type PracticeInputValues } from '../actions';
import { StepError, StepFoot, useStepAction } from '../wizard-client';

export interface PracticeDefaults {
  name: string;
  billingNpi: string;
  taxIdLast4: string | null;
  taxonomy: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  timezone: string;
  contact: string;
}

export function PracticeForm({
  clientId,
  defaults,
}: {
  clientId: string | null;
  defaults: PracticeDefaults;
}) {
  const [v, setV] = useState({ ...defaults, taxId: '' });
  const { pending, error, run } = useStepAction();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const npiOk = /^\d{10}$/.test(v.billingNpi) && isValidNpi(v.billingNpi);
  const npiBad = /^\d{10}$/.test(v.billingNpi) && !npiOk;
  const input: PracticeInputValues = {
    name: v.name,
    billingNpi: v.billingNpi.trim(),
    taxId: v.taxId.trim() || null,
    taxonomy: v.taxonomy || null,
    line1: v.line1,
    city: v.city,
    state: v.state,
    zip: v.zip,
    timezone: v.timezone as PracticeInputValues['timezone'],
    contact: v.contact || null,
  };
  return (
    <form
      className="stack-lg"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => savePracticeAction(clientId, input));
      }}
    >
      <div className="card">
        <div className="card-body form-grid">
          <div className="field full">
            <label htmlFor="o1n">Billing NPI</label>
            <input
              id="o1n"
              className="input mono"
              style={{ maxWidth: 420 }}
              inputMode="numeric"
              autoComplete="off"
              value={v.billingNpi}
              onChange={set('billingNpi')}
              aria-invalid={npiBad || undefined}
              aria-describedby="o1n-help"
              required
            />
            <span className="help" id="o1n-help">
              {npiOk ? (
                <span className="chip chip-good">
                  <CircleCheck aria-hidden />
                  Passes its check digit
                </span>
              ) : npiBad ? (
                <span style={{ color: 'var(--danger)' }}>
                  This NPI fails its check digit. Check the number.
                </span>
              ) : (
                'The group NPI that goes on claims as the billing provider.'
              )}
            </span>
          </div>
          <div className="field full">
            <label htmlFor="o1l">Practice name</label>
            <input id="o1l" className="input" value={v.name} onChange={set('name')} required />
            <span className="help">As it appears on claims and in Cleanpost.</span>
          </div>
          <div className="field">
            <label htmlFor="o1t">Tax ID (EIN)</label>
            <input
              id="o1t"
              className="input mono"
              autoComplete="off"
              placeholder={defaults.taxIdLast4 ? `••-•••${defaults.taxIdLast4}` : '93-4418207'}
              value={v.taxId}
              onChange={set('taxId')}
              required={!defaults.taxIdLast4}
              aria-describedby="o1t-help"
            />
            <span className="help" id="o1t-help">
              {defaults.taxIdLast4
                ? 'Saved and encrypted. Leave blank to keep it.'
                : 'Encrypted and masked after saving.'}
            </span>
          </div>
          <div className="field">
            <label htmlFor="o1x">Taxonomy</label>
            <input
              id="o1x"
              className="input mono"
              placeholder="207N00000X"
              value={v.taxonomy}
              onChange={set('taxonomy')}
            />
          </div>
          <div className="field full">
            <label htmlFor="o1a">Billing street address</label>
            <input
              id="o1a"
              className="input"
              autoComplete="off"
              value={v.line1}
              onChange={set('line1')}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="o1city">City</label>
            <input id="o1city" className="input" value={v.city} onChange={set('city')} required />
          </div>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="field" style={{ width: 90 }}>
              <label htmlFor="o1st">State</label>
              <input
                id="o1st"
                className="input"
                maxLength={2}
                value={v.state}
                onChange={set('state')}
                required
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="o1zip">ZIP</label>
              <input id="o1zip" className="input mono" value={v.zip} onChange={set('zip')} required />
            </div>
          </div>
          <div className="field">
            <label htmlFor="o1z">Timezone</label>
            <select id="o1z" className="select" value={v.timezone} onChange={set('timezone')}>
              {TIME_ZONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="o1c">Practice billing contact</label>
            <input
              id="o1c"
              className="input"
              placeholder="Renee Walsh, office manager"
              value={v.contact}
              onChange={set('contact')}
            />
            <span className="help">Who you tell about the go-live date.</span>
          </div>
        </div>
      </div>
      <StepFoot back={null} aside={<StepError error={error} />}>
        <Button type="submit" variant="primary" disabled={pending || npiBad}>
          {pending ? 'Saving…' : 'Continue'}
        </Button>
      </StepFoot>
    </form>
  );
}
