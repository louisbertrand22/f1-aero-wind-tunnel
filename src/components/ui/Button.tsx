import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Kbd } from './Kbd';

export type ButtonVariant = 'outline' | 'accent' | 'reference' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  shortcut?: string;
  /** Stretch to the container width. */
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  outline: 'border-line-strong text-ink-dim hover:border-ink-dim hover:text-ink',
  accent: 'border-flowvis text-flowvis hover:bg-flowvis hover:text-carbon-950',
  reference: 'border-reference/70 text-reference hover:bg-reference hover:text-carbon-950',
  danger: 'border-line-strong text-ink-dim hover:border-loss hover:text-loss',
};

/** Hairline instrument button: condensed uppercase caption, optional icon and key hint. */
export function Button({ variant = 'outline', icon, shortcut, block = false, className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`group/btn inline-flex h-7 items-center justify-center gap-1.5 rounded-[2px] border bg-transparent px-2 font-cond text-[11px] font-semibold tracking-[0.1em] uppercase transition-colors duration-100 disabled:pointer-events-none disabled:opacity-35 ${VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {icon}
      <span className="truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto pl-1 group-hover/btn:opacity-60">
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </button>
  );
}
