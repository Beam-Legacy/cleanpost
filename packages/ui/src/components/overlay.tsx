import { X } from 'lucide-react';
import { AlertDialog, Dialog, DropdownMenu, Popover as P } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx';
import { Button } from './button';

interface OverlayProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the overlay; omit when controlled. */
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

function CloseButton() {
  return (
    <Dialog.Close asChild>
      <button type="button" className="icon-btn ghost close" aria-label="Close">
        <X aria-hidden />
      </button>
    </Dialog.Close>
  );
}

/** Modal dialog (Radix Dialog): focus trap, Escape to close, labelled by its title. */
export function Modal({ size, ...p }: OverlayProps & { size?: 'sm' | 'lg' | 'xl' }) {
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      {p.trigger && <Dialog.Trigger asChild>{p.trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="cp-scrim" />
        <div className="cp-center">
          <Dialog.Content className={cx('modal', size)}>
            <div className="modal-head">
              <div>
                <Dialog.Title asChild>
                  <h2>{p.title}</h2>
                </Dialog.Title>
                {p.description ? (
                  <Dialog.Description className="muted dense">{p.description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{p.title}</Dialog.Description>
                )}
              </div>
              <CloseButton />
            </div>
            {p.children && <div className="modal-body">{p.children}</div>}
            {p.footer && <div className="modal-foot">{p.footer}</div>}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Drawer from the right edge (Radix Dialog). */
export function Drawer({ wide, ...p }: OverlayProps & { wide?: boolean }) {
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      {p.trigger && <Dialog.Trigger asChild>{p.trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="cp-scrim" />
        <Dialog.Content className={cx('drawer', 'cp-fixed', wide && 'wide')}>
          <div className="drawer-head">
            <div>
              <Dialog.Title asChild>
                <h2>{p.title}</h2>
              </Dialog.Title>
              {p.description ? (
                <Dialog.Description className="muted dense">{p.description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{p.title}</Dialog.Description>
              )}
            </div>
            <CloseButton />
          </div>
          <div className="drawer-body">{p.children}</div>
          {p.footer && <div className="drawer-foot">{p.footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Names the outcome, e.g. "Release 41 claims". */
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

/**
 * G-11 Confirm action: for actions that send data to a payer or PM, which cannot be undone
 * (docs/09-ui-screens.md); other actions use a toast with Undo instead.
 */
export function ConfirmDialog(p: ConfirmProps) {
  return (
    <AlertDialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="cp-scrim" />
        <div className="cp-center">
          <AlertDialog.Content className="modal sm">
            <div className="modal-head">
              <AlertDialog.Title asChild>
                <h2>{p.title}</h2>
              </AlertDialog.Title>
            </div>
            <AlertDialog.Description asChild>
              <div className="modal-body">{p.description}</div>
            </AlertDialog.Description>
            <div className="modal-foot">
              <AlertDialog.Cancel asChild>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant={p.danger ? 'danger' : 'primary'} onClick={p.onConfirm}>
                  {p.confirmLabel}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </div>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function Popover({
  trigger,
  children,
  label,
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content className="popover cp-floating" sideOffset={6} align="start" aria-label={label}>
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

export interface MenuItem {
  label: string;
  meta?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/** Dropdown menu with keyboard navigation (Radix DropdownMenu). */
export function Menu({ trigger, items, label }: { trigger: ReactElement; items: (MenuItem | 'separator')[]; label: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="popover menu cp-floating" sideOffset={6} align="end" aria-label={label}>
          {items.map((item, i) =>
            item === 'separator' ? (
              <DropdownMenu.Separator key={i} className="menu-sep" />
            ) : (
              <DropdownMenu.Item key={i} className="menu-item" disabled={item.disabled} onSelect={item.onSelect}>
                {item.icon}
                {item.label}
                {item.meta && <span className="meta">{item.meta}</span>}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
