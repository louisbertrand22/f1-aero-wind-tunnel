import type { ReactNode } from 'react';

/** Key-cap hint for a keyboard shortcut. */
export function Kbd({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'onAccent' }) {
  const toneClass = tone === 'onAccent' ? 'border-carbon-950/50 text-carbon-950' : 'border-line-strong text-ink-mute';
  return (
    <kbd className={`num inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[2px] border px-1 text-[9px] leading-none font-medium ${toneClass}`}>
      {children}
    </kbd>
  );
}
