import type { PresetId } from '../../types';

/** Side-view pictogram of each test article (flow comes from the left). */
export function PresetGlyph({ preset, className = '' }: { preset: PresetId; className?: string }) {
  return (
    <svg viewBox="0 0 44 22" width="44" height="22" aria-hidden="true" className={className} fill="currentColor" stroke="none">
      {preset === 'rearWing' ? (
        <>
          <path d="M4 12.5C10 9.5 20 10.5 27 15.5 19 16 10 15.5 4 12.5Z" />
          <path d="M26.5 11.5C30 8.5 35 5.5 40 3.5 37.5 7.5 33.5 11 28 13.2Z" />
        </>
      ) : null}
      {preset === 'frontWing' ? (
        <>
          <path d="M4 14.5C9 13.5 15 14.5 19.5 16.8 14 17.3 8.5 16.8 4 14.5Z" />
          <path d="M19.5 13.8C22.5 12.2 25.5 11.6 28.5 12 26.8 13.8 24 15 20.8 15.6Z" />
          <path d="M28.6 10.2C30.6 8.2 33.4 6.8 36 6.3 34.6 8.8 32.2 10.8 29.7 11.8Z" />
          <path d="M36.3 4.8C37.8 3.3 39.4 2.4 41 2 40.4 4 39 6 37.4 7Z" />
          <path d="M2 20.5H42" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" fill="none" opacity="0.6" />
        </>
      ) : null}
      {preset === 'floor' ? (
        <>
          <path d="M3 11.5C3 8 7 6 12 6H37.5C39.8 6 41 7 41 9V10L30 16.5H14C10 16.5 6 15 3 11.5Z" />
          <path d="M2 20.5H42" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" fill="none" opacity="0.6" />
        </>
      ) : null}
      {preset === 'freeform' ? (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="M22 14C25 7 29 17 33 10S39 8 41 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </>
      ) : null}
    </svg>
  );
}
