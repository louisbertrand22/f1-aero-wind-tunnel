import { memo } from 'react';
import type { ReactNode } from 'react';
import { Activity, AlertTriangle, Loader, Pause, Wind } from 'lucide-react';
import type { Baseline, PerfStats, Telemetry, TunnelParams, TunnelStatus } from '../types';
import { PRESETS } from '../geometry/presets';
import { DASH, clamp, fmt, fmtPercent, fmtTunnelTime, relativeDelta, sciParts } from '../lib/format';
import { DeltaBadge } from './ui/Delta';
import type { Better } from './ui/Delta';

export interface TelemetryHeaderProps {
  telemetry: Telemetry | null;
  perf: PerfStats;
  params: TunnelParams;
  /** Actual DRS flap position, 0 = closed … 1 = fully open. */
  drsPosition: number;
  baseline: Baseline | null;
  status: TunnelStatus;
}

/* ───────────────────────────── brand + status ───────────────────────────── */

const STATUS_META: Record<TunnelStatus, { label: string; className: string; icon: ReactNode }> = {
  booting: { label: 'Initialisation', className: 'text-ink-dim', icon: <Loader size={11} aria-hidden="true" className="animate-spin" /> },
  running: { label: 'En soufflage', className: 'text-gain', icon: <Activity size={11} aria-hidden="true" /> },
  paused: { label: 'En pause', className: 'text-warn', icon: <Pause size={11} aria-hidden="true" /> },
  unstable: { label: 'Solveur instable', className: 'text-loss', icon: <AlertTriangle size={11} aria-hidden="true" /> },
};

const Brand = memo(function Brand({ status, presetLabel }: { status: TunnelStatus; presetLabel: string }) {
  const meta = STATUS_META[status];
  return (
    <div className="flex w-[176px] shrink-0 flex-col justify-between border-r border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 32 20" width="32" height="20" aria-hidden="true" className="shrink-0">
          <path d="M1 5h10M1 10h7M1 15h10" stroke="var(--color-ink-mute)" strokeWidth="1.5" strokeLinecap="square" />
          <path d="M11 14c5-8 11-9.5 20-7-5 1.2-9 4.5-11 9z" fill="var(--color-flowvis)" />
        </svg>
        <div className="min-w-0 leading-none">
          <div className="font-cond text-[19px] leading-[18px] font-bold tracking-[0.16em] text-ink">AEROLAB</div>
          <div className="label-cond mt-[1px] text-[9px] tracking-[0.14em] whitespace-nowrap">Soufflerie virtuelle F1</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span role="status" className={`flex items-center gap-1 font-cond text-[11px] font-semibold tracking-[0.1em] whitespace-nowrap uppercase ${meta.className}`}>
          {meta.icon}
          {meta.label}
        </span>
        <span className="num truncate text-[9px] text-ink-mute uppercase">{presetLabel}</span>
      </div>
    </div>
  );
});

/* ───────────────────────────────── heroes ───────────────────────────────── */

interface HeroTileProps {
  label: string;
  english: string;
  /** Tailwind background class of the series identity bar. */
  swatch: string;
  value: number;
  digits: number;
  unit: string;
  /** Width of the numeric field in `ch` so the layout never jitters. */
  widthCh: number;
  secondary: string | null;
  secondaryUnit: string;
  reference: number | null;
  better: Better;
  /** Deltas smaller than this are shown as flat. */
  epsilon: number;
  className: string;
}

const HeroTile = memo(function HeroTile(p: HeroTileProps) {
  const hasValue = Number.isFinite(p.value);
  const delta = p.reference !== null && hasValue ? p.value - p.reference : null;
  return (
    <div className={`relative flex shrink-0 flex-col justify-between border-r border-line py-2 pr-3 pl-4 ${p.className}`}>
      <span aria-hidden="true" className={`absolute top-2 bottom-2 left-[6px] w-[3px] ${p.swatch}`} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-cond text-ink-dim">{p.label}</span>
        <span className="label-cond text-[9px]">{p.english}</span>
      </div>
      <div className="flex items-baseline gap-1.5 leading-none">
        <span className="num text-[30px] leading-[30px] font-semibold tracking-[-0.02em] text-ink" style={{ minWidth: `${p.widthCh}ch`, textAlign: 'right' }}>
          {hasValue ? fmt(p.value, p.digits) : DASH}
        </span>
        <span className="font-cond text-[13px] font-semibold text-ink-mute">{p.unit}</span>
      </div>
      <div className="flex h-[14px] items-center justify-between gap-2 text-[10px] leading-none">
        <span className="num whitespace-nowrap text-ink-dim">
          {p.secondary !== null ? (
            <>
              {p.secondary}
              <span className="ml-1 text-ink-mute">{p.secondaryUnit}</span>
            </>
          ) : null}
        </span>
        {delta !== null && p.reference !== null ? (
          <DeltaBadge delta={delta} relative={relativeDelta(p.value, p.reference)} digits={p.digits} unit={p.unit === 'N' ? 'N' : undefined} better={p.better} epsilon={p.epsilon} />
        ) : null}
      </div>
    </div>
  );
});

/* ─────────────────────────────── balance gauge ─────────────────────────────── */

const BalanceGauge = memo(function BalanceGauge({ copFrac, refFrac }: { copFrac: number; refFrac: number | null }) {
  const valid = Number.isFinite(copFrac);
  const pos = valid ? clamp(copFrac, 0, 1) * 100 : 50;
  const refPos = refFrac !== null && Number.isFinite(refFrac) ? clamp(refFrac, 0, 1) * 100 : null;
  return (
    <div className="flex w-[140px] shrink-0 flex-col justify-between border-r border-line px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="label-cond text-ink-dim">Balance aéro</span>
        <span className="label-cond text-[9px]">CdP</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="num min-w-[4ch] text-right text-[17px] leading-[18px] font-semibold text-ink">{valid ? fmt(copFrac * 100, 1) : DASH}</span>
        <span className="font-cond text-[11px] font-semibold text-ink-mute">% corde</span>
      </div>
      <div
        role="meter"
        aria-label="Position du centre de poussée depuis le bord d'attaque"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valid ? Math.round(pos) : undefined}
        aria-valuetext={valid ? fmtPercent(copFrac, 1) : 'indéfini'}
      >
        <div className="relative h-[10px]">
          <span aria-hidden="true" className="absolute inset-x-0 top-[4px] h-[2px] bg-line-strong" />
          <span aria-hidden="true" className="absolute top-[1px] left-0 h-[8px] w-px bg-line-strong" />
          <span aria-hidden="true" className="absolute top-[2px] left-1/2 h-[6px] w-px bg-line-strong" />
          <span aria-hidden="true" className="absolute top-[1px] right-0 h-[8px] w-px bg-line-strong" />
          {refPos !== null ? (
            <span aria-hidden="true" title="Référence" className="absolute top-0 h-[10px] w-[2px] -translate-x-1/2 bg-reference" style={{ left: `${refPos}%` }} />
          ) : null}
          {valid ? (
            <span aria-hidden="true" className="absolute top-0 h-[10px] w-[4px] -translate-x-1/2 bg-ink shadow-[0_0_0_1px_var(--color-carbon-900)] transition-[left] duration-150" style={{ left: `${pos}%` }} />
          ) : null}
        </div>
        <div className="mt-[1px] flex justify-between">
          <span className="label-cond text-[9px]">AV</span>
          <span className="label-cond text-[9px]">AR</span>
        </div>
      </div>
    </div>
  );
});

/* ───────────────────────────── secondary stats ───────────────────────────── */

const Stat = memo(function Stat({ label, value, unit, widthCh = 5, title }: { label: ReactNode; value: string; unit?: string; widthCh?: number; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-[3px] overflow-hidden px-2.5" title={title}>
      <span className="label-cond text-[10px] leading-none whitespace-nowrap">{label}</span>
      <span className="num text-[13px] leading-none whitespace-nowrap text-ink">
        <span className="inline-block font-medium" style={{ minWidth: `${widthCh}ch` }}>
          {value}
        </span>
        {unit ? <span className="ml-1 text-[9px] text-ink-mute">{unit}</span> : null}
      </span>
    </div>
  );
});

/** Two stacked stats; whole columns drop out (never overlap) when the header runs out of room. */
function StatColumn({ className, children }: { className: string; children: ReactNode }) {
  return <div className={`shrink-0 grid-rows-2 ${className}`}>{children}</div>;
}

/* ─────────────────────────────── DRS + dirty air ─────────────────────────────── */

type DrsState = 'unavailable' | 'closed' | 'moving' | 'open';

const DRS_META: Record<DrsState, { caption: string; box: string }> = {
  unavailable: { caption: 'Indispo.', box: 'border-line text-ink-mute opacity-50' },
  closed: { caption: 'Fermé', box: 'border-line-strong text-ink-dim' },
  moving: { caption: 'Transit', box: 'border-flowvis text-flowvis' },
  open: { caption: 'Ouvert', box: 'border-flowvis bg-flowvis text-carbon-950' },
};

const DrsLamp = memo(function DrsLamp({ available, position, dirtyAir, gapS }: { available: boolean; position: number; dirtyAir: boolean; gapS: number }) {
  const pos = clamp(Number.isFinite(position) ? position : 0, 0, 1);
  const state: DrsState = !available ? 'unavailable' : pos > 0.97 ? 'open' : pos < 0.03 ? 'closed' : 'moving';
  const meta = DRS_META[state];
  return (
    <div className="flex w-[104px] shrink-0 flex-col justify-between border-r border-line px-2.5 py-2">
      <div
        role="status"
        aria-label={`DRS ${meta.caption}`}
        className={`relative flex h-[40px] items-center justify-between overflow-hidden rounded-[2px] border px-2 transition-colors duration-100 ${meta.box}`}
      >
        <span className="font-cond text-[22px] leading-none font-bold tracking-[0.08em]">DRS</span>
        <span className="font-cond text-[10px] leading-none font-semibold tracking-[0.1em] uppercase">{meta.caption}</span>
        {state === 'moving' ? <span aria-hidden="true" className="absolute bottom-0 left-0 h-[2px] bg-flowvis" style={{ width: `${pos * 100}%` }} /> : null}
      </div>
      <div
        role="status"
        className={`flex items-center gap-1 font-cond text-[10px] leading-none font-semibold tracking-[0.1em] whitespace-nowrap uppercase ${dirtyAir ? 'text-warn' : 'text-ink-mute'}`}
        title={dirtyAir ? `Sillage d'une voiture ${fmt(gapS, 1)} s devant` : 'Veine en air propre'}
      >
        {dirtyAir ? <AlertTriangle size={11} aria-hidden="true" /> : <Wind size={11} aria-hidden="true" />}
        {dirtyAir ? (
          <>
            Air sale <span className="num text-[9px] font-medium normal-case">{fmt(gapS, 1)} s</span>
          </>
        ) : (
          'Air propre'
        )}
      </div>
    </div>
  );
});

/* ───────────────────────────────── perf ───────────────────────────────── */

const PerfBlock = memo(function PerfBlock({ stepsPerSecond, mlups, substeps, requested, simFps, renderFps }: { stepsPerSecond: number; mlups: number; substeps: number; requested: number; simFps: number; renderFps: number }) {
  const throttled = substeps > 0 && substeps < requested;
  return (
    <div className="hidden w-[156px] shrink-0 grid-cols-2 grid-rows-2 py-1.5 lg:grid">
      <Stat label="Pas / s" value={fmt(stepsPerSecond, 0)} widthCh={4} />
      <Stat label="MLUPS" value={fmt(mlups, 1)} widthCh={4} title="Millions de mises à jour de sites par seconde" />
      <Stat
        label="Sous-pas"
        value={`${fmt(substeps, 0)}/${fmt(requested, 0)}`}
        widthCh={5}
        title={throttled ? 'Sous-pas réduits : le solveur dépasse le budget de la trame' : 'Sous-pas exécutés / demandés par image'}
      />
      <Stat label="FPS sim·vue" value={`${fmt(simFps, 0)}·${fmt(renderFps, 0)}`} widthCh={5} />
    </div>
  );
});

/* ───────────────────────────────── header ───────────────────────────────── */

function TelemetryHeader({ telemetry, perf, params, drsPosition, baseline, status }: TelemetryHeaderProps) {
  const spec = PRESETS[params.preset];
  const t = telemetry;
  const ref = baseline?.telemetry ?? null;
  const nan = Number.NaN;

  const downforce = t?.downforceN ?? nan;
  const drag = t?.dragN ?? nan;
  const ld = t?.ld ?? nan;
  const rePhys = sciParts(t?.reynoldsPhys ?? nan, 6, 2);
  const time = fmtTunnelTime(t?.simTimeS ?? nan);
  // Force deltas below 0.1 % of the reference read as "flat".
  const epsForce = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? Math.max(0.5, Math.abs(v) * 0.001) : 0.5);

  return (
    <header className="flex h-[84px] w-full shrink-0 items-stretch overflow-hidden border-b border-line bg-carbon-900 select-none">
      <Brand status={status} presetLabel={spec.shortLabel} />

      <HeroTile
        label="Appui"
        english="Downforce"
        swatch="bg-series-df"
        value={downforce}
        digits={0}
        unit="N"
        widthCh={6}
        secondary={t ? fmt(t.downforceKgf, 1) : DASH}
        secondaryUnit="kgf"
        reference={ref ? ref.downforceN : null}
        better="higher"
        epsilon={epsForce(ref?.downforceN)}
        className="w-[204px]"
      />
      <HeroTile
        label="Traînée"
        english="Drag"
        swatch="bg-series-drag"
        value={drag}
        digits={0}
        unit="N"
        widthCh={5}
        secondary={null}
        secondaryUnit=""
        reference={ref ? ref.dragN : null}
        better="lower"
        epsilon={epsForce(ref?.dragN)}
        className="w-[160px]"
      />
      <HeroTile
        label="Finesse"
        english="L/D"
        swatch="bg-series-ld"
        value={ld}
        digits={2}
        unit=""
        widthCh={5}
        secondary={null}
        secondaryUnit=""
        reference={ref ? ref.ld : null}
        better="higher"
        epsilon={0.005}
        className="w-[142px]"
      />

      <BalanceGauge copFrac={t?.copFrac ?? nan} refFrac={ref ? ref.copFrac : null} />

      <div className="@container flex min-w-0 flex-1 overflow-hidden border-r border-line py-1.5">
        <StatColumn className="grid w-[76px]">
          <Stat
            label={
              <>
                C<sub className="text-[8px]">z</sub> appui
              </>
            }
            value={fmt(t?.cl ?? nan, 3)}
            widthCh={6}
            title="Coefficient d'appui (−C_L), rapporté à la corde de référence"
          />
          <Stat
            label={
              <>
                C<sub className="text-[8px]">x</sub> traînée
              </>
            }
            value={fmt(t?.cd ?? nan, 3)}
            widthCh={6}
            title="Coefficient de traînée"
          />
        </StatColumn>
        <StatColumn className="hidden w-[82px] @min-[158px]:grid">
          <Stat label="Vitesse" value={fmt(params.speedKmh, 0)} unit="km/h" widthCh={3} />
          <Stat label="Mach ∞" value={fmt(t?.machInf ?? nan, 3)} widthCh={5} />
        </StatColumn>
        <StatColumn className="hidden w-[92px] @min-[250px]:grid">
          <Stat label="Re réel" value={rePhys.mantissa} unit={rePhys.exponent} widthCh={4} title="Reynolds de la pièce à l'échelle 1 (V·c/ν)" />
          <Stat label="Re simulé" value={fmt(t?.reynoldsSim ?? nan, 0)} widthCh={5} title="Reynolds effectivement résolu par le réseau" />
        </StatColumn>
        <StatColumn className="hidden w-[90px] @min-[340px]:grid">
          <Stat label="q∞ dyn." value={fmt((t?.qInf ?? nan) / 1000, 2)} unit="kPa" widthCh={4} title="Pression dynamique amont" />
          <Stat label="Temps veine" value={time.value} unit={time.unit} widthCh={5} title="Temps physique simulé dans la veine" />
        </StatColumn>
      </div>

      <DrsLamp available={spec.drs} position={drsPosition} dirtyAir={params.dirtyAir} gapS={params.dirtyAirGapS} />

      <PerfBlock stepsPerSecond={perf.stepsPerSecond} mlups={perf.mlups} substeps={perf.substeps} requested={params.substeps} simFps={perf.simFps} renderFps={perf.renderFps} />
    </header>
  );
}

export default memo(TelemetryHeader);
