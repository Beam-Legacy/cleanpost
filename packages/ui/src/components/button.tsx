'use client';
import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import { Tooltip } from './tooltip';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  /** Render the child element (e.g. a link) with button styles. */
  asChild?: boolean;
}

/** Button. Labels name the outcome ("Release claim"), docs/10-design-system.md. */
export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  asChild,
  className,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      type={asChild ? undefined : (type ?? 'button')}
      className={cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className)}
      {...props}
    />
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  /** Required: becomes aria-label and the tooltip text. */
  label: string;
  icon: ReactNode;
  ghost?: boolean;
}

/** Icon-only button: always has an accessible name and a tooltip. */
export function IconButton({ label, icon, ghost, className, type, ...props }: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type={type ?? 'button'}
        aria-label={label}
        className={cx('icon-btn', ghost && 'ghost', className)}
        {...props}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
