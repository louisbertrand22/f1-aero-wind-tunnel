import type { ReactNode } from 'react';
import { Kbd } from './Kbd';

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
}

/** Full-row switch. State is carried by block position + ON/OFF caption, not colour alone. */
export function Toggle({ label, checked, onChange, hint, icon, shortcut, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group/tg flex w-full items-center gap-2 py-[5px] text-left disabled:pointer-events-none disabled:opacity-40"
    >
      {icon ? <span className={`shrink-0 ${checked ? 'text-ink' : 'text-ink-mute'}`}>{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[12px] leading-4 ${checked ? 'text-ink' : 'text-ink-dim'} group-hover/tg:text-ink`}>{label}</span>
        {hint ? <span className="block text-[11px] leading-[14px] text-ink-mute">{hint}</span> : null}
      </span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      <span className={`num w-[22px] shrink-0 text-right text-[9px] font-medium ${checked ? 'text-flowvis' : 'text-ink-mute'}`}>{checked ? 'ON' : 'OFF'}</span>
      <span
        aria-hidden="true"
        className={`relative h-[12px] w-[26px] shrink-0 rounded-[2px] border transition-colors duration-100 ${checked ? 'border-flowvis' : 'border-line-strong group-hover/tg:border-ink-mute'}`}
      >
        <span
          className={`absolute top-[2px] h-[6px] w-[10px] rounded-[1px] transition-[left,background-color] duration-100 ${checked ? 'left-[12px] bg-flowvis' : 'left-[2px] bg-ink-mute'}`}
        />
      </span>
    </button>
  );
}
