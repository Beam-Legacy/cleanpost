'use client';
import { CircleX } from 'lucide-react';
import { Switch as S } from 'radix-ui';
import {
  useId,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '../cx';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Receives the id and ARIA wiring for the control. */
  children: (control: FieldControlProps) => ReactElement;
}

/** Label, control, help and error text, wired together for assistive technology. */
export function Field({ label, help, error, children }: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <span className="error" id={errorId}>
          <CircleX aria-hidden />
          {error}
        </span>
      )}
      {help && (
        <span className="help" id={helpId}>
          {help}
        </span>
      )}
    </div>
  );
}

export function Input({ className, mono, ...props }: ComponentProps<'input'> & { mono?: boolean }) {
  return (
    <input
      className={cx('input', mono && 'mono', props['aria-invalid'] && 'invalid', className)}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cx('select', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cx('textarea', className)} {...props} />;
}

export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}

export interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, checked, onCheckedChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <span className="row">
      <S.Root
        id={id}
        className="switch"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
      <label htmlFor={id} className="dense">
        {label}
      </label>
    </span>
  );
}
