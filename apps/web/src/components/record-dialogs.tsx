'use client';
/**
 * P-02 Edit coverage and P-06 Edit patient details (DEC-30). The PM stays the system of record and
 * cannot be written from Cleanpost yet, so saving keeps the correction here and puts a task in the
 * queue to make it in the PM; claims for the patient wait until the PM shows it.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactElement } from 'react';
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  Select,
  useToast,
} from '@cleanpost/ui';
import type { CoverageView, PatientEditView } from '@/lib/queries/patients';
import {
  editCoverageAction,
  editPatientAction,
  patientForEditAction,
  type EditResult,
} from '@/app/(app)/patients/actions';

const ORDER = [
  { value: 1, label: 'Primary' },
  { value: 2, label: 'Secondary' },
  { value: 3, label: 'Tertiary' },
];
const RELATIONSHIP = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'child', label: 'Child' },
  { value: 'other', label: 'Other' },
];

function PmCallout({ pmName, what }: { pmName: string; what: string }) {
  return (
    <Callout>
      {pmName} cannot be updated from Cleanpost yet. Saving creates a task to update {what} in {pmName};
      claims for this patient wait until {pmName} shows the change.
    </Callout>
  );
}

export function CoverageDialog({
  coverage,
  payers,
  pmName,
  trigger,
  onSaved,
}: {
  coverage: CoverageView;
  payers: { id: string; name: string }[];
  pmName: string;
  trigger: ReactElement;
  onSaved?: () => void;
}) {
  const initial = {
    payerId: coverage.payerId ?? '',
    memberId: '',
    groupNumber: coverage.groupNumber ?? '',
    relationship: coverage.relationship,
    priority: coverage.priority,
    effectiveDate: coverage.effectiveDate ?? '',
    terminationDate: coverage.terminationDate ?? '',
    checkEligibility: true,
  };
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial);
  const [error, setError] = useState<EditResult | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((x) => ({ ...x, [k]: value }));
  const err = (f: string) => (error?.field === f ? error.message : undefined);

  const save = () =>
    start(async () => {
      setError(null);
      const res = await editCoverageAction(coverage.id, v);
      if (!res.ok) {
        setError(res);
        return;
      }
      toast({ message: res.message });
      setOpen(false);
      onSaved?.();
      router.refresh();
    });

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setV(initial);
          setError(null);
        }
      }}
      trigger={trigger}
      title={`Edit ${coverage.payerName} coverage`}
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending || !v.payerId}
            aria-busy={pending || undefined}
            onClick={save}
          >
            {pending ? (v.checkEligibility ? 'Saving and checking…' : 'Saving…') : 'Save coverage'}
          </Button>
        </>
      }
    >
      <PmCallout pmName={pmName} what="coverage" />
      <Field label="Payer" error={err('payerId')}>
        {(p) => (
          <Select {...p} value={v.payerId} onChange={(e) => set('payerId', e.target.value)}>
            {!v.payerId && <option value="">Choose a payer</option>}
            {payers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid-2">
        <Field
          label="Member ID"
          help={`Leave blank to keep the current ID (ends ${coverage.memberIdLast4}).`}
          error={err('memberId')}
        >
          {(p) => (
            <Input
              {...p}
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder={`•••••${coverage.memberIdLast4}`}
              value={v.memberId}
              onChange={(e) => set('memberId', e.target.value)}
            />
          )}
        </Field>
        <Field label="Group number" error={err('groupNumber')}>
          {(p) => (
            <Input
              {...p}
              mono
              autoComplete="off"
              value={v.groupNumber}
              onChange={(e) => set('groupNumber', e.target.value)}
            />
          )}
        </Field>
        <Field label="Order" help="Changing it swaps with the coverage that has that place.">
          {(p) => (
            <Select {...p} value={v.priority} onChange={(e) => set('priority', Number(e.target.value))}>
              {ORDER.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Patient's relationship to the subscriber">
          {(p) => (
            <Select {...p} value={v.relationship} onChange={(e) => set('relationship', e.target.value)}>
              {RELATIONSHIP.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Start date" error={err('effectiveDate')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              value={v.effectiveDate}
              onChange={(e) => set('effectiveDate', e.target.value)}
            />
          )}
        </Field>
        <Field label="End date" error={err('terminationDate')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              value={v.terminationDate}
              onChange={(e) => set('terminationDate', e.target.value)}
            />
          )}
        </Field>
      </div>
      <Checkbox
        label="Check eligibility after saving"
        checked={v.checkEligibility}
        onChange={(e) => set('checkEligibility', e.currentTarget.checked)}
      />
      {error && !error.field && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
    </Modal>
  );
}

type PatientForm = {
  firstName: string;
  lastName: string;
  dob: string;
  sex: 'M' | 'F' | 'U';
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
};

const toForm = (p: PatientEditView): PatientForm => ({
  firstName: p.firstName,
  lastName: p.lastName,
  dob: p.dob,
  sex: p.sex,
  line1: p.address?.line1 ?? '',
  line2: p.address?.line2 ?? '',
  city: p.address?.city ?? '',
  state: p.address?.state ?? '',
  zip: p.address?.zip ?? '',
  phone: p.phone ?? '',
});

export function PatientDialog({ patientId, trigger }: { patientId: string; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<PatientEditView | null>(null);
  const [v, setV] = useState<PatientForm | null>(null);
  const [error, setError] = useState<EditResult | null>(null);
  const [discard, setDiscard] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const dirty = Boolean(loaded && v && JSON.stringify(toForm(loaded)) !== JSON.stringify(v));
  const set = <K extends keyof PatientForm>(k: K, value: PatientForm[K]) =>
    setV((x) => (x ? { ...x, [k]: value } : x));
  const err = (f: string) => (error?.field === f ? error.message : undefined);

  const openDialog = (o: boolean) => {
    if (!o && dirty) {
      setDiscard(true);
      return;
    }
    setOpen(o);
    if (o) {
      setError(null);
      setLoaded(null);
      setV(null);
      // The full date of birth and address are shown to edit them: a reveal, audited.
      start(async () => {
        const p = await patientForEditAction(patientId);
        setLoaded(p);
        setV(p ? toForm(p) : null);
      });
    }
  };

  const save = () =>
    start(async () => {
      if (!v) return;
      setError(null);
      const res = await editPatientAction(patientId, {
        firstName: v.firstName,
        lastName: v.lastName,
        dob: v.dob,
        sex: v.sex,
        address: { line1: v.line1, line2: v.line2, city: v.city, state: v.state, zip: v.zip },
        phone: v.phone,
      });
      if (!res.ok) {
        setError(res);
        return;
      }
      toast({ message: res.message });
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Modal
        open={open}
        onOpenChange={openDialog}
        trigger={trigger}
        title="Edit patient details"
        footer={
          <>
            <Button onClick={() => openDialog(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending || !v || !dirty}
              aria-busy={pending || undefined}
              onClick={save}
            >
              {pending && v ? 'Saving…' : 'Save details'}
            </Button>
          </>
        }
      >
        {!v ? (
          <p className="muted" aria-busy={pending || undefined}>
            {pending ? 'Loading details…' : 'These details could not be loaded.'}
          </p>
        ) : (
          <>
            <PmCallout pmName={loaded?.pmName ?? 'the PM'} what="the patient" />
            <div className="grid-2">
              <Field label="First name" error={err('firstName')}>
                {(p) => (
                  <Input {...p} value={v.firstName} onChange={(e) => set('firstName', e.target.value)} />
                )}
              </Field>
              <Field label="Last name" error={err('lastName')}>
                {(p) => <Input {...p} value={v.lastName} onChange={(e) => set('lastName', e.target.value)} />}
              </Field>
              <Field label="Date of birth" error={err('dob')}>
                {(p) => (
                  <Input {...p} type="date" value={v.dob} onChange={(e) => set('dob', e.target.value)} />
                )}
              </Field>
              <Field label="Sex">
                {(p) => (
                  <Select
                    {...p}
                    value={v.sex}
                    onChange={(e) => set('sex', e.target.value as PatientForm['sex'])}
                  >
                    <option value="F">Female</option>
                    <option value="M">Male</option>
                    <option value="U">Unknown</option>
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Street address" error={err('line1')}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={v.line1}
                  onChange={(e) => set('line1', e.target.value)}
                />
              )}
            </Field>
            <Field label="Apartment, suite (optional)">
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={v.line2}
                  onChange={(e) => set('line2', e.target.value)}
                />
              )}
            </Field>
            <div className="grid-3">
              <Field label="City" error={err('city')}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="off"
                    value={v.city}
                    onChange={(e) => set('city', e.target.value)}
                  />
                )}
              </Field>
              <Field label="State" error={err('state')}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="off"
                    maxLength={2}
                    value={v.state}
                    onChange={(e) => set('state', e.target.value.toUpperCase())}
                  />
                )}
              </Field>
              <Field label="ZIP code" error={err('zip')}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="off"
                    inputMode="numeric"
                    value={v.zip}
                    onChange={(e) => set('zip', e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field label="Phone" error={err('phone')}>
              {(p) => (
                <Input
                  {...p}
                  type="tel"
                  autoComplete="off"
                  value={v.phone}
                  onChange={(e) => set('phone', e.target.value)}
                />
              )}
            </Field>
            {error &&
              !['firstName', 'lastName', 'dob', 'line1', 'city', 'state', 'zip', 'phone'].includes(
                error.field ?? '',
              ) && (
                <p className="error" role="alert">
                  {error.message}
                </p>
              )}
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard changes?"
        description="The changes to this patient's details have not been saved."
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          setDiscard(false);
          setOpen(false);
        }}
      />
    </>
  );
}
