'use client';
/** W-08 Save view, and removing a view of one's own. */
import { Bookmark, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, IconButton, Modal, useToast } from '@cleanpost/ui';
import { deleteView, saveView } from './actions';

export function SaveViewButton({ canShare, summary }: { canShare: boolean; summary: string }) {
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Bookmark aria-hidden />
        Save view
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Save view"
        size="sm"
        description={summary}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim() || pending}
              onClick={() =>
                start(async () => {
                  const filters = Object.fromEntries([...params.entries()].filter(([k]) => k !== 'item'));
                  const res = await saveView(name, filters, shared);
                  if (!res.ok) return setError(res.message);
                  toast({ message: res.message });
                  setOpen(false);
                  setName('');
                  setError(null);
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        <label className="field">
          <span className="label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={60}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'save-view-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          {error && (
            <span id="save-view-error" className="error">
              {error}
            </span>
          )}
        </label>
        {canShare && (
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>Share with the team (each person still sees only their clients)</span>
          </label>
        )}
      </Modal>
    </>
  );
}

export function RemoveViewButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <IconButton
      label={`Remove view ${name}`}
      icon={<X />}
      ghost
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await deleteView(id);
          toast({ message: res.message });
        })
      }
    />
  );
}
