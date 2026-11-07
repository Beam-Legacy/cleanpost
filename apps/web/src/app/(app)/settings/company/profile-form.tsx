'use client';
/**
 * S-14 profile and contacts with one Save (DEC-34). The security contact is required; the billing
 * contact may be left empty.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { Button, Field, Input, Select, useToast } from '@cleanpost/ui';
import type { company } from '@cleanpost/domain';
import { saveCompanyProfile, type ProfileErrors } from './actions';

interface Profile {
  legalName: string;
  name: string;
  address: string;
  phone: string;
  timezone: string;
  securityContact: company.Contact | null;
  billingContact: company.Contact | null;
}

export function ProfileForm({
  profile,
  timeZones,
  notice,
  agreements,
}: {
  profile: Profile;
  timeZones: { id: string; label: string }[];
  /** The no-BAA banner, under the heading. */
  notice?: ReactNode;
  /** The agreements card, between the profile and the contacts (as S-14 lays them out). */
  agreements: ReactNode;
}) {
  const [v, setV] = useState({
    legalName: profile.legalName,
    name: profile.name,
    address: profile.address,
    phone: profile.phone,
    timezone: profile.timezone,
    securityName: profile.securityContact?.name ?? '',
    securityEmail: profile.securityContact?.email ?? '',
    billingName: profile.billingContact?.name ?? '',
    billingEmail: profile.billingContact?.email ?? '',
  });
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const set = (k: keyof typeof v) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value;
    setV((s) => ({ ...s, [k]: value }));
  };

  const save = () =>
    start(async () => {
      const billing = v.billingName.trim() || v.billingEmail.trim();
      const res = await saveCompanyProfile({
        legalName: v.legalName,
        name: v.name,
        address: v.address,
        phone: v.phone,
        timezone: v.timezone as company.TimeZoneId,
        securityContact: { name: v.securityName, email: v.securityEmail.trim() },
        billingContact: billing ? { name: v.billingName, email: v.billingEmail.trim() } : null,
      });
      setErrors(res.errors ?? {});
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) router.refresh();
    });

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="row-between">
        <div>
          <h2 className="title-m">Company profile</h2>
          <p className="muted dense" style={{ margin: 0 }}>
            {profile.name}
          </p>
        </div>
        <Button type="submit" size="sm" variant="primary" disabled={pending} aria-busy={pending}>
          Save
        </Button>
      </div>
      {notice}
      <div className="card">
        <div className="card-body form-grid">
          <Field label="Legal name" error={errors.legalName}>
            {(p) => (
              <Input {...p} value={v.legalName} onChange={set('legalName')} autoComplete="organization" />
            )}
          </Field>
          <Field label="Display name" error={errors.name} help="Shown in Cleanpost and on reports.">
            {(p) => <Input {...p} value={v.name} onChange={set('name')} />}
          </Field>
          <div className="full">
            <Field label="Address" error={errors.address}>
              {(p) => (
                <Input {...p} value={v.address} onChange={set('address')} autoComplete="street-address" />
              )}
            </Field>
          </div>
          <Field label="Main phone" error={errors.phone}>
            {(p) => <Input {...p} value={v.phone} onChange={set('phone')} type="tel" autoComplete="tel" />}
          </Field>
          <Field label="Time zone" error={errors.timezone} help="For digests, due times and reports.">
            {(p) => (
              <Select {...p} value={v.timezone} onChange={set('timezone')}>
                {timeZones.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>
      {agreements}
      <div className="card">
        <div className="card-head">
          <h3>Contacts</h3>
        </div>
        <div className="card-body form-grid">
          <Field
            label="Security and privacy contact"
            error={errors.securityName}
            help="Receives breach and incident notices under the BAA. Required."
          >
            {(p) => <Input {...p} value={v.securityName} onChange={set('securityName')} placeholder="Name" />}
          </Field>
          <Field label="Security contact email" error={errors.securityEmail}>
            {(p) => <Input {...p} type="email" value={v.securityEmail} onChange={set('securityEmail')} />}
          </Field>
          <Field label="Billing contact" error={errors.billingName} help="Receives Cleanpost invoices.">
            {(p) => <Input {...p} value={v.billingName} onChange={set('billingName')} placeholder="Name" />}
          </Field>
          <Field label="Billing contact email" error={errors.billingEmail}>
            {(p) => <Input {...p} type="email" value={v.billingEmail} onChange={set('billingEmail')} />}
          </Field>
        </div>
      </div>
    </form>
  );
}
