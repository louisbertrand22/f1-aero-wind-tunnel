import { memo } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeftRight, Flag, MoveLeft, MoveRight, RefreshCw, X } from 'lucide-react';
import type { Baseline, Telemetry, TunnelParams } from '../types';
import { PRESETS } from '../geometry/presets';
import { DASH, clamp, digitsOfStep, fmt, fmtClock, fmtSigned, fmtSignedPercent, relativeDelta } from '../lib/format';
import { Button } from './ui/Button';
import { OUTCOME_BG, OUTCOME_TEXT, OutcomeIcon, outcomeOf } from './ui/Delta';
import type { Better } from './ui/Delta';

export interface ABComparatorProps {
  telemetry: Telemetry | null;
  baseline: Baseline | null;
  params: TunnelParams;
  onCapture: () => void;
  onClear: () => void;
}

/* ─────────────────────────────── setup summary ─────────────────────────────── */

interface SetupItem {
  key: string;
  label: string;
  value: string;
}

/** Human-readable setup of a run, limited to what the preset actually exposes. */
function describeSetup(p: TunnelParams): SetupItem[] {
  const spec = PRESETS[p.preset];
  const items: SetupItem[] = [
    { key: 'preset', label: 'Pièce', value: spec.shortLabel },
    { key: 'speed', label: 'V', value: `${fmt(p.speedKmh, 0)} km/h` },
  ];
  if (spec.drs) items.push({ key: 'drs', label: 'DRS', value: p.drsOpen ? 'ouvert' : 'fermé' });
  if (spec.aoa) items.push({ key: 'aoa', label: spec.id === 'floor' ? 'Rake' : 'α', value: `${fmt(p.angleOfAttackDeg, digitsOfStep(spec.aoa.step))}°` });
  if (spec.flap) items.push({ key: 'flap', label: spec.id === 'floor' ? 'Diffuseur' : 'Volet', value: `${fmt(p.flapAngleDeg, digitsOfStep(spec.flap.step))}°` });
  if (spec.rideHeight) items.push({ key: 'ride', label: 'Garde', value: `${fmt(p.rideHeightMm, 0)} mm` });
  items.push({ key: 'nu', label: 'ν', value: fmt(p.viscosity, 2) });
  items.push({ key: 'ground', label: 'Tapis', value: p.movingGround ? 'on' : 'off' });
  items.push({ key: 'dirty', label: 'Air', value: p.dirtyAir ? `sale ${fmt(p.dirtyAirGapS, 1)} s` : 'propre' });
  return items;
}

/** Setup items whose live value differs from the reference run. */
function setupChanges(reference: TunnelParams, live: TunnelParams): SetupItem[] {
  const ref = new Map(describeSetup(reference).map((it) => [it.key, it.value]));
  return describeSetup(live).filter((it) => ref.get(it.key) !== it.value);
}

/* ───────────────────────────────── rows ───────────────────────────────── */

interface MetricRowProps {
  label: string;
  /** Tailwind background class of the series swatch (null = no series identity). */
  swatch: string | null;
  reference: number;
  live: number;
  digits: number;
  better: Better;
  /** Full-scale of the centred delta bar (same unit as `barValue`). */
  barScale: number;
  /** 'relative' → bar and secondary figure in %, 'points' → absolute points. */
  mode: 'relative' | 'points';
  epsilon: number;
}

const GRID = 'grid h-[16px] grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.9fr)] items-center gap-x-2 leading-none';

const MetricRow = memo(function MetricRow({ label, swatch, reference, live, digits, better, barScale, mode, epsilon }: MetricRowProps) {
  const valid = Number.isFinite(reference) && Number.isFinite(live);
  const delta = valid ? live - reference : Number.NaN;
  const rel = mode === 'relative' ? relativeDelta(live, reference) : Number.NaN;
  const outcome = outcomeOf(delta, better, epsilon);
  const barValue = mode === 'relative' ? rel : delta;
  const barFrac = Number.isFinite(barValue) ? clamp(barValue / barScale, -1, 1) : 0;
  const saturated = Math.abs(barFrac) >= 1;
  // Balance has no "better" side: show where the centre of pressure moved instead.
  const neutralShift = better === 'neutral' && valid && Math.abs(delta) > epsilon;

  return (
    <div role="row" className="pt-[2px]">
      <div className={GRID}>
        <span role="rowheader" className="flex min-w-0 items-center gap-1.5">
          {swatch ? <span aria-hidden="true" className={`h-[2px] w-2 shrink-0 ${swatch}`} /> : <span aria-hidden="true" className="h-[2px] w-2 shrink-0 bg-ink-mute" />}
          <span className="truncate font-cond text-[11px] font-semibold tracking-[0.08em] text-ink-dim uppercase">{label}</span>
        </span>
        <span role="cell" className="num text-right text-[11px] text-reference">
          {fmt(reference, digits)}
        </span>
        <span role="cell" className="num text-right text-[11px] font-medium text-ink">
          {fmt(live, digits)}
        </span>
        <span role="cell" className={`num flex items-center justify-end gap-1 text-[11px] whitespace-nowrap ${neutralShift ? 'text-ink' : OUTCOME_TEXT[outcome]}`}>
          {neutralShift ? delta > 0 ? <MoveRight size={12} aria-hidden="true" /> : <MoveLeft size={12} aria-hidden="true" /> : <OutcomeIcon outcome={outcome} />}
          <span className="sr-only">{neutralShift ? (delta > 0 ? 'Recule vers l’arrière :' : 'Avance vers l’avant :') : outcome === 'gain' ? 'Gain :' : outcome === 'loss' ? 'Perte :' : 'Stable :'}</span>
          <span className="font-medium">{valid ? fmtSigned(delta, digits) : DASH}</span>
          <span className="min-w-[6.5ch] text-right text-[10px] opacity-80">
            {mode === 'relative' ? fmtSignedPercent(rel, 1) : valid ? (neutralShift ? (delta > 0 ? 'pts AR' : 'pts AV') : 'pts') : ''}
          </span>
        </span>
      </div>
      {/* delta bar centred on zero */}
      <div aria-hidden="true" className="relative h-[3px] bg-carbon-800">
        <span className="absolute top-[-1px] left-1/2 h-[5px] w-px bg-line-strong" />
        {barFrac !== 0 ? (
          <span
            className={`absolute top-0 h-[3px] ${neutralShift ? 'bg-ink-dim' : OUTCOME_BG[outcome]}`}
            style={barFrac > 0 ? { left: '50%', width: `${barFrac * 50}%` } : { right: '50%', width: `${-barFrac * 50}%` }}
          />
        ) : null}
        {saturated ? <span className={`absolute top-[-1px] h-[5px] w-[2px] bg-ink ${barFrac > 0 ? 'right-0' : 'left-0'}`} /> : null}
      </div>
    </div>
  );
});

/* ───────────────────────────────── panel ───────────────────────────────── */

function HeaderButton({ label, title, icon, onClick, disabled = false, tone }: { label: string; title: string; icon: ReactNode; onClick: () => void; disabled?: boolean; tone: 'reference' | 'danger' }) {
  const toneClass = tone === 'reference' ? 'border-reference/60 text-reference hover:bg-reference hover:text-carbon-950' : 'border-line-strong text-ink-dim hover:border-loss hover:text-loss';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[2px] border px-1.5 font-cond text-[10px] leading-none font-semibold tracking-[0.08em] uppercase transition-colors duration-100 disabled:pointer-events-none disabled:opacity-35 ${toneClass}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ABComparator({ telemetry, baseline, params, onCapture, onClear }: ABComparatorProps) {
  const header = (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3">
      <ArrowLeftRight size={12} aria-hidden="true" className="shrink-0 text-ink-mute" />
      <span className="label-cond whitespace-nowrap text-ink-dim">Comparateur A/B</span>
      <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-line" />
      {baseline ? (
        <>
          <HeaderButton tone="reference" label="Remplacer" title="Remplacer la référence par le setup courant [B]" icon={<RefreshCw size={9} aria-hidden="true" />} onClick={onCapture} disabled={!telemetry} />
          <HeaderButton tone="danger" label="Effacer" title="Effacer le run de référence" icon={<X size={10} aria-hidden="true" />} onClick={onClear} />
        </>
      ) : (
        <span className="num text-[9px] whitespace-nowrap text-ink-mute">aucune réf.</span>
      )}
    </div>
  );

  if (!baseline) {
    return (
      <section aria-label="Comparateur A/B" className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-carbon-900">
        {header}
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-2 overflow-y-auto px-3 py-2.5">
          <div>
            <div className="flex items-center gap-1.5 text-reference">
              <Flag size={13} aria-hidden="true" />
              <span className="font-cond text-[13px] font-semibold tracking-[0.08em] text-ink uppercase">Aucun run de référence</span>
            </div>
            <p className="m-0 mt-1.5 text-[11.5px] leading-[16px] text-ink-dim">
              Figez le setup courant comme <span className="text-reference">référence</span> (ex. DRS fermé), puis modifiez le réglage : les écarts d'appui, de traînée, de finesse et de balance s'affichent en direct.
            </p>
          </div>
          <Button block variant="reference" icon={<Flag size={12} aria-hidden="true" />} shortcut="B" disabled={!telemetry} onClick={onCapture} title={telemetry ? undefined : 'En attente des premières mesures'}>
            Enregistrer le run de référence
          </Button>
        </div>
      </section>
    );
  }

  const ref = baseline.telemetry;
  const refSetup = describeSetup(baseline.params);
  const refSummary = refSetup.map((it) => (it.key === 'preset' ? it.value : `${it.label} ${it.value}`)).join(' · ');
  const changes = setupChanges(baseline.params, params);
  const changeSummary = changes.map((it) => (it.key === 'preset' ? it.value : `${it.label} ${it.value}`)).join(' · ');
  const nan = Number.NaN;
  const live = telemetry;

  return (
    <section aria-label="Comparateur A/B" className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-carbon-900">
      {header}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pt-[5px] pb-1">
        <div className="flex items-center gap-1.5">
          <Flag size={11} aria-hidden="true" className="shrink-0 text-reference" />
          <span className="min-w-0 flex-1 truncate font-cond text-[12px] leading-[14px] font-semibold tracking-[0.06em] text-ink uppercase" title={baseline.label}>
            {baseline.label}
          </span>
          <span className="num shrink-0 text-[9px] text-ink-mute" title="Heure d'enregistrement du run de référence">
            {fmtClock(baseline.capturedAt)}
          </span>
        </div>
        <p className="num m-0 mt-[1px] flex items-baseline gap-1.5 text-[9.5px] leading-[13px] whitespace-nowrap" title={`Setup de référence : ${refSummary}`}>
          <span className="label-cond w-[52px] shrink-0 text-[9px] text-reference">Setup réf.</span>
          <span className="truncate text-ink-dim">{refSummary}</span>
        </p>
        <p className="num m-0 flex items-baseline gap-1.5 text-[9.5px] leading-[13px] whitespace-nowrap" title={changes.length ? `Modifications live : ${changeSummary}` : undefined}>
          <span className="label-cond w-[52px] shrink-0 text-[9px]">Modifs live</span>
          {changes.length === 0 ? <span className="truncate text-ink-mute">setup identique à la référence</span> : <span className="truncate text-ink">{changeSummary}</span>}
        </p>

        <div role="table" aria-label="Écarts entre le run live et le run de référence" className="mt-[3px]">
          <div role="row" className={`${GRID} !h-[13px] border-b border-line`}>
            <span role="columnheader" className="label-cond text-[9px]">
              Mesure
            </span>
            <span role="columnheader" className="label-cond text-right text-[9px] text-reference">
              Réf.
            </span>
            <span role="columnheader" className="label-cond text-right text-[9px] text-ink-dim">
              Live
            </span>
            <span role="columnheader" className="label-cond text-right text-[9px]" title="Barres centrées sur zéro : pleine échelle ±25 % (balance : ±10 points de corde)">
              Δ live − réf.
            </span>
          </div>
          <MetricRow
            label="Appui"
            swatch="bg-series-df"
            reference={ref.downforceN}
            live={live?.downforceN ?? nan}
            digits={0}
            better="higher"
            barScale={0.25}
            mode="relative"
            epsilon={Math.max(0.5, Math.abs(ref.downforceN) * 0.001)}
          />
          <MetricRow
            label="Traînée"
            swatch="bg-series-drag"
            reference={ref.dragN}
            live={live?.dragN ?? nan}
            digits={0}
            better="lower"
            barScale={0.25}
            mode="relative"
            epsilon={Math.max(0.5, Math.abs(ref.dragN) * 0.001)}
          />
          <MetricRow label="Finesse" swatch="bg-series-ld" reference={ref.ld} live={live?.ld ?? nan} digits={2} better="higher" barScale={0.25} mode="relative" epsilon={0.005} />
          <MetricRow label="Balance" swatch={null} reference={ref.copFrac * 100} live={(live?.copFrac ?? nan) * 100} digits={1} better="neutral" barScale={10} mode="points" epsilon={0.05} />
        </div>
      </div>
    </section>
  );
}

export default memo(ABComparator);
