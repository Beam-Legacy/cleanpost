'use client';
/** S-01 pending invite row: send it again (a new link, 7 more days) or withdraw it. */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ellipsis, Send, X } from 'lucide-react';
import { Button, Menu, Modal, useToast } from '@cleanpost/ui';
import { resendInvite, revokeInvite, type UserActionResult } from './actions';
import { InviteLinks } from './invite-links';

export function InviteRowActions({ id, email }: { id: string; email: string }) {
  const [pending, start] = useTransition();
  const [links, setLinks] = useState<UserActionResult['links']>();
  const toast = useToast();
  const router = useRouter();
  const run = (fn: typeof resendInvite) =>
    start(async () => {
      const res = await fn(id);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.links) setLinks(res.links);
      router.refresh();
    });
  return (
    <>
      <Menu
        label={`Invite to ${email}`}
        trigger={
          <button
            type="button"
            className="icon-btn ghost"
            aria-label={`Invite actions for ${email}`}
            disabled={pending}
          >
            <Ellipsis aria-hidden />
          </button>
        }
        items={[
          { label: 'Resend invite', icon: <Send aria-hidden />, onSelect: () => run(resendInvite) },
          { label: 'Withdraw invite', icon: <X aria-hidden />, onSelect: () => run(revokeInvite) },
        ]}
      />
      {links && (
        <Modal
          open
          onOpenChange={(o) => !o && setLinks(undefined)}
          title="New invite link"
          size="sm"
          footer={
            <Button variant="primary" onClick={() => setLinks(undefined)}>
              Done
            </Button>
          }
        >
          <InviteLinks links={links} />
        </Modal>
      )}
    </>
  );
}
