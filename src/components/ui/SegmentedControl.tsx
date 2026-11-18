import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  icon?: ReactNode;
  title?: string;
}

export interface SegmentedControlProps<T extends string | number> {
  ariaLabel: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Radio group drawn as joined hairline cells; arrow keys move the selection. */
export function SegmentedControl<T extends string | number>({ ariaLabel, options, value, onChange, disabled = false }: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const current = options.findIndex((o) => o.value === value);
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = (Math.max(0, current) + dir + options.length) % options.length;
    onChange(options[next].value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
    buttons?.[next]?.focus();
  };

  return (
    <div ref={groupRef} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown} className="flex w-full">
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={opt.title}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`relative flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 border px-1.5 font-cond text-[11px] font-semibold tracking-[0.08em] uppercase transition-colors duration-100 focus-visible:z-20 disabled:opacity-40 ${i > 0 ? '-ml-px' : ''} ${
              active ? 'z-10 border-flowvis bg-flowvis/10 text-flowvis' : 'border-line-strong text-ink-dim hover:text-ink'
            }`}
          >
            {opt.icon}
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
