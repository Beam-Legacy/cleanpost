import type { Metadata } from 'next';
import { Card, CardBody, CardHead, KeyValue, StatusChip } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { requireActiveContext } from '@/lib/session';
import { SignOutOthers } from './sign-out-others';

export const metadata: Metadata = { title: 'Profile and security' };

/** A-09 Profile and security (M0: identity, second factor, sessions). */
export default async function AccountPage() {
  const ctx = await requireActiveContext();
  return (
    <>
      <PageHead title="Profile and security" />
      <div className="grid-2">
        <Card>
          <CardHead title="Profile" />
          <CardBody>
            <KeyValue
              items={[
                ['Name', ctx.user.name],
                ['Email', ctx.user.email],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHead title="Sign-in security" />
          <CardBody className="stack">
            <KeyValue items={[['Two-factor sign-in', <StatusChip key="s" status="Healthy" />]]} />
            <SignOutOthers />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
