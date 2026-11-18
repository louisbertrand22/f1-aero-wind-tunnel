import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SectionProps {
  /** Two-digit rack index shown before the title ("01"). */
  index: string;
  title: string;
  /** Short live status shown on the right of the header (e.g. "OUVERT"). */
  status?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible sidebar rack unit: numbered header on a hairline, content below. */
export function Section({ index, title, status, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="border-b border-line">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="group/sec flex h-8 w-full items-center gap-2 px-3 text-left focus-visible:outline-offset-[-2px]"
        >
          <span className="num text-[9px] font-medium text-ink-mute">{index}</span>
          <span className="label-cond text-ink-dim group-hover/sec:text-ink">{title}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-line" />
          {status ? <span className="num text-[9px] font-medium tracking-wide text-ink-mute uppercase">{status}</span> : null}
          <ChevronDown size={12} aria-hidden="true" className={`text-ink-mute transition-transform duration-150 ${open ? '' : '-rotate-90'}`} />
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className="px-3 pt-0.5 pb-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}
