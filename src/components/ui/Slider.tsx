import { useId } from 'react';
import { clamp, digitsOfStep, fmt } from '../../lib/format';

export interface SliderProps {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Double-click anywhere on the control restores this value. */
  defaultValue?: number;
  onChange: (value: number) => void;
  /** Custom value text (defaults to fr-FR with the decimals implied by `step`). */
  format?: (value: number) => string;
  disabled?: boolean;
}

/** Width of the native thumb, px — the fill and markers are inset by half of it. */
const THUMB = 8;

const INPUT_CLASS = [
  'absolute inset-0 m-0 h-5 w-full cursor-ew-resize appearance-none bg-transparent outline-none disabled:cursor-not-allowed',
  '[&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:bg-transparent',
  '[&::-webkit-slider-thumb]:mt-[2px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:rounded-[1px] [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-ink',
  '[&::-webkit-slider-thumb]:shadow-[0_0_0_2px_var(--color-carbon-900)]',
  'hover:[&::-webkit-slider-thumb]:bg-flowvis focus-visible:[&::-webkit-slider-thumb]:bg-flowvis active:[&::-webkit-slider-thumb]:bg-flowvis',
  '[&::-moz-range-track]:h-5 [&::-moz-range-track]:bg-transparent',
  '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-2 [&::-moz-range-thumb]:rounded-[1px] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-ink',
  'hover:[&::-moz-range-thumb]:bg-flowvis focus-visible:[&::-moz-range-thumb]:bg-flowvis',
].join(' ');

/**
 * Fader-style range control: hairline track with a ruler, thin block thumb,
 * live value in tabular mono on the right. Built on a native range input, so
 * keyboard (arrows, Home/End, PageUp/Down) and assistive tech work as-is.
 */
export function Slider({ label, unit = '', value, min, max, step, defaultValue, onChange, format, disabled = false }: SliderProps) {
  const id = useId();
  const digits = digitsOfStep(step);
  const text = format ? format(value) : fmt(value, digits);
  const span = max - min;
  const frac = span > 0 ? clamp((value - min) / span, 0, 1) : 0;
  const defFrac = defaultValue !== undefined && span > 0 ? clamp((defaultValue - min) / span, 0, 1) : null;
  const atDefault = defaultValue !== undefined && Math.abs(value - defaultValue) < step / 2;
  const pos = (f: number): string => `calc(${f.toFixed(4)} * (100% - ${THUMB}px) + ${THUMB / 2}px)`;

  const reset = (): void => {
    if (!disabled && defaultValue !== undefined && !atDefault) onChange(defaultValue);
  };

  return (
    <div
      className={`group/sl py-1 ${disabled ? 'opacity-40' : ''}`}
      onDoubleClick={reset}
      title={defaultValue !== undefined ? `Double-clic : retour à ${fmt(defaultValue, digits)}${unit ? ` ${unit}` : ''}` : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="min-w-0 truncate text-[12px] leading-4 text-ink-dim group-hover/sl:text-ink">
          {label}
        </label>
        <span className="num shrink-0 text-[12px] leading-4 whitespace-nowrap text-ink">
          <span className="inline-block min-w-[5ch] text-right font-medium">{text}</span>
          {unit ? <span className="ml-1 text-[10px] text-ink-mute">{unit}</span> : null}
        </span>
      </div>
      <div className="relative h-5">
        {/* ruler */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[13px] h-[3px] opacity-70"
          style={{
            left: THUMB / 2,
            right: THUMB / 2,
            backgroundImage: 'repeating-linear-gradient(to right, var(--color-line-strong) 0 1px, transparent 1px calc(10% - 0.1px))',
            borderRight: '1px solid var(--color-line-strong)',
          }}
        />
        {/* track */}
        <span aria-hidden="true" className="pointer-events-none absolute top-[9px] h-[2px] bg-line-strong" style={{ left: THUMB / 2, right: THUMB / 2 }} />
        {/* fill */}
        <span aria-hidden="true" className="pointer-events-none absolute top-[9px] h-[2px] bg-ink-dim group-hover/sl:bg-ink" style={{ left: THUMB / 2, width: `calc(${frac.toFixed(4)} * (100% - ${THUMB}px))` }} />
        {/* default marker */}
        {defFrac !== null ? (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute top-[3px] h-[5px] w-px -translate-x-1/2 ${atDefault ? 'bg-transparent' : 'bg-ink-dim'}`}
            style={{ left: pos(defFrac) }}
          />
        ) : null}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={`${text}${unit ? ` ${unit}` : ''}`}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
          className={INPUT_CLASS}
        />
      </div>
    </div>
  );
}
