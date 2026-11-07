import type { Metadata } from 'next';
import { Download, FileText } from 'lucide-react';
import { Banner } from '@cleanpost/ui';
import { company } from '@cleanpost/domain';
import { formatDate } from '@/lib/format';
import { companyProfile, type AgreementRow } from '@/lib/queries/company';
import { requireActiveContext } from '@/lib/session';
import { ProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Company profile' };

const AGREEMENT: Record<AgreementRow['type'], string> = {
  baa: 'Business associate agreement',
  customer_agreement: 'Customer agreement',
};

function Agreement({ type, row }: { type: AgreementRow['type']; row: AgreementRow | null }) {
  return (
    <div className="row-between" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <FileText aria-hidden />
        <div>
          <b className="dense">{AGREEMENT[type]}</b>
          <p className="subtle" style={{ margin: 0 }}>
            {row
              ? `Version ${row.version}${
                  row.signedAt
                    ? ` · signed${row.signedBy ? ` by ${row.signedBy}` : ''}, ${formatDate(row.signedAt.toISOString().slice(0, 10))}`
                    : ' · not signed yet'
                }`
              : 'Not on file'}
          </p>
        </div>
      </div>
      {row?.downloadable && (
        <a
          className="btn btn-ghost btn-sm"
          href={`/settings/company/agreements/${row.id}`}
          aria-label={`Download the ${AGREEMENT[type].toLowerCase()}`}
        >
          <Download aria-hidden />
          Download
        </a>
      )}
    </div>
  );
}

/**
 * S-14 Company profile (DEC-34): the billing company's details, its signed agreements and the
 * contacts Cleanpost must reach. Without a signed BAA, Cleanpost does not process real patient data
 * for the company (the danger banner).
 */
export default async function CompanyProfilePage() {
  const ctx = await requireActiveContext();
  const { profile, baa, customerAgreement } = await companyProfile(ctx);
  return (
    <ProfileForm
      profile={profile}
      timeZones={[...company.US_TIME_ZONES]}
      notice={
        !baa?.signedAt && (
          <Banner tone="bad">
            <b>No business associate agreement on file.</b> Cleanpost does not process real patient data for{' '}
            {profile.name} until one is signed. Your Cleanpost contact sends it for signature.
          </Banner>
        )
      }
      agreements={
        <div className="card">
          <div className="card-head">
            <h3>Agreements</h3>
          </div>
          <div className="card-body stack-sm">
            <Agreement type="baa" row={baa} />
            <hr className="divider" />
            <Agreement type="customer_agreement" row={customerAgreement} />
          </div>
        </div>
      }
    />
  );
}
