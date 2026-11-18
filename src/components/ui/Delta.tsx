import { ChevronsDown, ChevronsUp, Minus } from 'lucide-react';
import { fmtSigned, fmtSignedPercent } from '../../lib/format';

/** Which direction of change is an improvement for a metric. */
export type Better = 'higher' | 'lower' | 'neutral';
export type Outcome = 'gain' | 'loss' | 'flat';

export function outcomeOf(delta: number, better: Better, epsilon = 0): Outcome {
  if (!Number.isFinite(delta) || better === 'neutral' || Math.abs(delta) <= epsilon) return 'flat';
  const improved = better === 'higher' ? delta > 0 : delta < 0;
  return improved ? 'gain' : 'loss';
}

export const OUTCOME_TEXT: Record<Outcome, string> = {
  gain: 'text-gain',
  loss: 'text-loss',
  flat: 'text-ink-dim',
};

export const OUTCOME_BG: Record<Outcome, string> = {
  gain: 'bg-gain',
  loss: 'bg-loss',
  flat: 'bg-ink-mute',
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  gain: 'Gain',
  loss: 'Perte',
  flat: 'Stable',
};

export function OutcomeIcon({ outcome, size = 12 }: { outcome: Outcome; size?: number }) {
  const Icon = outcome === 'gain' ? ChevronsUp : outcome === 'loss' ? ChevronsDown : Minus;
  return <Icon size={size} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />;
}

export interface DeltaBadgeProps {
  /** Absolute change (live − reference). */
  delta: number;
  /** Relative change as a fraction; omit / NaN to hide the percentage. */
  relative?: number;
  digits?: number;
  unit?: string;
  better: Better;
  /** Changes smaller than this read as "flat". */
  epsilon?: number;
}

/**
 * Signed delta vs the reference run. The icon encodes the OUTCOME (gain /
 * loss), the sign of the number encodes the direction — status never relies
 * on colour alone.
 */
export function DeltaBadge({ delta, relative, digits = 0, unit, better, epsilon = 0 }: DeltaBadgeProps) {
  const outcome = outcomeOf(delta, better, epsilon);
  const showRel = relative !== undefined && Number.isFinite(relative);
  return (
    <span className={`num inline-flex items-center gap-1 whitespace-nowrap ${OUTCOME_TEXT[outcome]}`} title={`${OUTCOME_LABEL[outcome]} vs référence`}>
      <OutcomeIcon outcome={outcome} />
      <span className="sr-only">{OUTCOME_LABEL[outcome]} :</span>
      <span className="font-medium">
        {fmtSigned(delta, digits)}
        {unit ? <span className="ml-0.5 text-[0.85em] opacity-80">{unit}</span> : null}
      </span>
      {showRel ? <span className="opacity-80">{fmtSignedPercent(relative, 1)}</span> : null}
    </span>
  );
}
