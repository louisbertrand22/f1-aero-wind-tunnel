import { memo } from 'react';
import type { CSSProperties } from 'react';
import { Brush, Crosshair, Eraser, MoveUpRight, Pause, Play, RotateCcw, Sparkles, SprayCan, Trash2, Waves, Wind } from 'lucide-react';
import type { BrushMode, GridSize, LayerId, PresetId, TunnelCommand, TunnelParams, ViewSettings } from '../types';
import { GRID_OPTIONS } from '../types';
import { DIRTY_AIR_GAP_RANGE, PRESETS, PRESET_ORDER, SPEED_RANGE, SUBSTEP_RANGE, VISCOSITY_RANGE, presetDefaults } from '../geometry/presets';
import type { RangeSpec } from '../geometry/presets';
import { fmt } from '../lib/format';
import { Button } from './ui/Button';
import { Kbd } from './ui/Kbd';
import { PresetGlyph } from './ui/PresetGlyph';
import { Section } from './ui/Section';
import { SegmentedControl } from './ui/SegmentedControl';
import type { SegmentOption } from './ui/SegmentedControl';
import { Slider } from './ui/Slider';
import { Toggle } from './ui/Toggle';

export interface ControlSidebarProps {
  params: TunnelParams;
  onChange: (patch: Partial<TunnelParams>) => void;
  view: ViewSettings;
  onViewChange: (patch: Partial<ViewSettings>) => void;
  onCommand: (command: TunnelCommand) => void;
  grid: GridSize;
  onGridChange: (grid: GridSize) => void;
}

/* ───────────────────────────── layer catalogue ───────────────────────────── */

interface LayerMeta {
  id: LayerId;
  label: string;
  hint: string;
  shortcut: string;
  /** Miniature of the colour map used by the canvas for this layer. */
  swatch: CSSProperties;
}

const LAYERS: readonly LayerMeta[] = [
  {
    id: 'pressure',
    label: 'Pression Cp',
    hint: 'Succion ↔ surpression',
    shortcut: '1',
    swatch: { background: 'linear-gradient(90deg,#c9f1ff,#5fb4ff 12%,#1f62e0 27%,#152f8f 40%,#12151b 50%,#7a1d12 60%,#d2401a 73%,#f79a1e 88%,#fff09a)' },
  },
  {
    id: 'velocity',
    label: 'Vélocité |V|',
    hint: 'Venturi & stagnation',
    shortcut: '2',
    swatch: { background: 'linear-gradient(90deg,#07080c,#231c52 18%,#27509d 40%,#1f95a4 60%,#63d389 80%,#f4fcae)' },
  },
  {
    id: 'vorticity',
    label: 'Vorticité ∇×V',
    hint: 'Tourbillons & décrochage',
    shortcut: '3',
    swatch: { background: 'linear-gradient(90deg,#c4fff2,#22cdb8 20%,#0e5f66 38%,#090b0f 50%,#6b1450 62%,#ef3d94 80%,#ffd2e6)' },
  },
  {
    id: 'smoke',
    label: 'Fumée & lignes de courant',
    hint: 'Filets colorés injectés en amont',
    shortcut: '4',
    swatch: { background: 'repeating-linear-gradient(180deg,#0b0d10 0 2px,#e9edf1 2px 3px,#0b0d10 3px 5px,#58b6ff 5px 6px,#0b0d10 6px 8px,#ffb347 8px 9px)' },
  },
];

const BRUSH_OPTIONS: readonly SegmentOption<BrushMode>[] = [
  { value: 'paint', label: 'Pinceau', icon: <Brush size={12} aria-hidden="true" />, title: 'Ajouter de la matière' },
  { value: 'erase', label: 'Gomme', icon: <Eraser size={12} aria-hidden="true" />, title: 'Retirer de la matière' },
];

/* ───────────────────────────── building blocks ───────────────────────────── */

function RangeSlider({ spec, value, onChange, label }: { spec: RangeSpec; value: number; onChange: (v: number) => void; label?: string }) {
  return <Slider label={label ?? spec.label} unit={spec.unit} value={value} min={spec.min} max={spec.max} step={spec.step} defaultValue={spec.default} onChange={onChange} />;
}

function PresetList({ active, onSelect }: { active: PresetId; onSelect: (id: PresetId) => void }) {
  return (
    <div role="radiogroup" aria-label="Configuration aérodynamique" className="flex flex-col">
      {PRESET_ORDER.map((id, i) => {
        const spec = PRESETS[id];
        const selected = id === active;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (!selected) onSelect(id);
            }}
            className={`group/pr relative flex w-full items-start gap-2.5 border px-2 py-[7px] text-left transition-colors duration-100 focus-visible:z-20 ${i > 0 ? '-mt-px' : ''} ${
              selected ? 'z-10 border-flowvis bg-flowvis/[0.06]' : 'border-line hover:border-line-strong hover:bg-carbon-850'
            }`}
          >
            <PresetGlyph preset={id} className={`mt-[1px] shrink-0 ${selected ? 'text-flowvis' : 'text-ink-mute group-hover/pr:text-ink-dim'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={`truncate text-[12.5px] leading-4 font-medium ${selected ? 'text-ink' : 'text-ink-dim group-hover/pr:text-ink'}`}>{spec.label}</span>
              </span>
              {selected ? <span className="mt-0.5 block text-[11px] leading-[14px] text-ink-dim">{spec.description}</span> : null}
            </span>
            <span className={`num mt-[1px] shrink-0 text-[9px] font-medium ${selected ? 'text-flowvis' : 'text-ink-mute'}`}>{selected ? 'ACTIF' : `C${i + 1}`}</span>
          </button>
        );
      })}
    </div>
  );
}

function DrsButton({ available, open, onToggle }: { available: boolean; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={open}
      disabled={!available}
      onClick={onToggle}
      className={`flex h-[52px] w-full items-center gap-3 rounded-[2px] border px-3 text-left transition-colors duration-100 disabled:pointer-events-none disabled:opacity-35 ${
        open ? 'border-flowvis bg-flowvis text-carbon-950' : 'border-line-strong text-ink hover:border-flowvis hover:text-flowvis'
      }`}
    >
      <span className="font-cond text-[28px] leading-none font-bold tracking-[0.08em]">DRS</span>
      <span className="min-w-0 flex-1">
        <span className="block font-cond text-[13px] leading-[14px] font-bold tracking-[0.12em] uppercase">{!available ? 'Indisponible' : open ? 'Volet ouvert' : 'Volet fermé'}</span>
        <span className={`block text-[10.5px] leading-[13px] ${open ? 'text-carbon-950/75' : 'text-ink-mute'}`}>
          {!available ? 'Pas de volet mobile sur cette pièce' : open ? 'Traînée réduite — appui en baisse' : 'Appui maximal'}
        </span>
      </span>
      <Kbd tone={open ? 'onAccent' : 'default'}>D</Kbd>
    </button>
  );
}

function LayerList({ active, onSelect }: { active: LayerId; onSelect: (id: LayerId) => void }) {
  return (
    <div role="radiogroup" aria-label="Calque de visualisation" className="flex flex-col">
      {LAYERS.map((layer, i) => {
        const selected = layer.id === active;
        return (
          <button
            key={layer.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(layer.id)}
            className={`group/ly relative flex h-[34px] w-full items-center gap-2.5 border px-2 text-left transition-colors duration-100 focus-visible:z-20 ${i > 0 ? '-mt-px' : ''} ${
              selected ? 'z-10 border-flowvis bg-flowvis/[0.06]' : 'border-line hover:border-line-strong hover:bg-carbon-850'
            }`}
          >
            <span aria-hidden="true" className={`h-[18px] w-[30px] shrink-0 border ${selected ? 'border-ink-dim' : 'border-line-strong opacity-70 group-hover/ly:opacity-100'}`} style={layer.swatch} />
            <span className="min-w-0 flex-1 leading-none">
              <span className={`block truncate text-[12px] leading-[14px] ${selected ? 'font-medium text-ink' : 'text-ink-dim group-hover/ly:text-ink'}`}>{layer.label}</span>
              <span className="block truncate text-[10px] leading-[12px] text-ink-mute">{layer.hint}</span>
            </span>
            <Kbd>{layer.shortcut}</Kbd>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────────────── sidebar ───────────────────────────────── */

function ControlSidebar({ params, onChange, view, onViewChange, onCommand, grid, onGridChange }: ControlSidebarProps) {
  const spec = PRESETS[params.preset];
  const gridOptions: SegmentOption<string>[] = GRID_OPTIONS.map((g) => ({ value: `${g.nx}x${g.ny}`, label: g.label, title: `${fmt(g.nx * g.ny, 0)} cellules` }));
  const gridValue = `${grid.nx}x${grid.ny}`;

  return (
    <aside aria-label="Réglages du banc d'essai" className="flex h-full w-[320px] shrink-0 flex-col overflow-hidden border-r border-line bg-carbon-900 select-none">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <Section index="01" title="Configuration" status={spec.shortLabel}>
          <PresetList active={params.preset} onSelect={(id) => onChange(presetDefaults(id))} />
        </Section>

        <Section index="02" title="DRS" status={!spec.drs ? 'n/d' : params.drsOpen ? 'ouvert' : 'fermé'}>
          <DrsButton available={spec.drs} open={spec.drs && params.drsOpen} onToggle={() => onChange({ drsOpen: !params.drsOpen })} />
        </Section>

        <Section index="03" title="Paramètres du banc" status={`${fmt(params.speedKmh, 0)} km/h`}>
          <RangeSlider spec={SPEED_RANGE} value={params.speedKmh} onChange={(v) => onChange({ speedKmh: v })} />
          {spec.aoa ? <RangeSlider spec={spec.aoa} value={params.angleOfAttackDeg} onChange={(v) => onChange({ angleOfAttackDeg: v })} /> : null}
          {spec.flap ? <RangeSlider spec={spec.flap} value={params.flapAngleDeg} onChange={(v) => onChange({ flapAngleDeg: v })} /> : null}
          {spec.rideHeight ? <RangeSlider spec={spec.rideHeight} value={params.rideHeightMm} onChange={(v) => onChange({ rideHeightMm: v })} /> : null}
          <RangeSlider spec={VISCOSITY_RANGE} value={params.viscosity} onChange={(v) => onChange({ viscosity: v })} />
          <div className="mt-1 border-t border-line pt-1.5">
            <Toggle
              label="Tapis roulant"
              hint="Sol défilant à la vitesse du flux"
              icon={<MoveUpRight size={13} aria-hidden="true" className="rotate-45" />}
              checked={params.movingGround}
              onChange={(v) => onChange({ movingGround: v })}
            />
          </div>
        </Section>

        <Section index="04" title="Calques">
          <LayerList active={view.layer} onSelect={(id) => onViewChange({ layer: id })} />
          <div className="mt-2">
            <Toggle label="Traceurs lagrangiens" hint="Particules suivant les lignes de courant" icon={<Sparkles size={13} aria-hidden="true" />} checked={view.particles} onChange={(v) => onViewChange({ particles: v })} />
            <Toggle label="Peinture Flow-Vis" hint="Cisaillement accumulé sur le profil" icon={<SprayCan size={13} aria-hidden="true" />} checked={view.flowVis} onChange={(v) => onViewChange({ flowVis: v })} />
            <Toggle label="Sonde Pitot" hint="Pression, vitesse et Mach au survol" icon={<Crosshair size={13} aria-hidden="true" />} checked={view.probe} onChange={(v) => onViewChange({ probe: v })} />
            <Toggle label="Vecteurs d'efforts" hint="Résultante et centre de poussée" icon={<MoveUpRight size={13} aria-hidden="true" />} checked={view.forces} onChange={(v) => onViewChange({ forces: v })} />
          </div>
          <div className="mt-2">
            <Button block icon={<Trash2 size={12} aria-hidden="true" />} onClick={() => onCommand('resetFlowVis')}>
              Nettoyer la peinture
            </Button>
          </div>
        </Section>

        <Section index="05" title="Injecteur de fumée" status={params.smokeEnabled ? `${params.smokeNozzles} buses` : 'coupé'}>
          <Toggle label="Râteau de fumée" hint="Buses en amont de la veine" icon={<Waves size={13} aria-hidden="true" />} checked={params.smokeEnabled} onChange={(v) => onChange({ smokeEnabled: v })} />
          <Slider label="Nombre de buses" value={params.smokeNozzles} min={1} max={24} step={1} defaultValue={12} disabled={!params.smokeEnabled} onChange={(v) => onChange({ smokeNozzles: v })} />
          <Slider
            label="Position du râteau"
            unit="% h"
            value={params.smokeCenter}
            min={0}
            max={1}
            step={0.01}
            defaultValue={0.5}
            disabled={!params.smokeEnabled}
            format={(v) => fmt(v * 100, 0)}
            onChange={(v) => onChange({ smokeCenter: v })}
          />
          <Slider
            label="Envergure du râteau"
            unit="% h"
            value={params.smokeSpread}
            min={0.05}
            max={1}
            step={0.01}
            defaultValue={0.7}
            disabled={!params.smokeEnabled}
            format={(v) => fmt(v * 100, 0)}
            onChange={(v) => onChange({ smokeSpread: v })}
          />
          <div className="mt-1.5">
            <Button block icon={<Wind size={12} aria-hidden="true" />} onClick={() => onCommand('clearSmoke')}>
              Purger la fumée
            </Button>
          </div>
        </Section>

        <Section index="06" title="Air sale" status={params.dirtyAir ? `${fmt(params.dirtyAirGapS, 1)} s` : 'propre'}>
          <Toggle label="Sillage d'une voiture de tête" icon={<Wind size={13} aria-hidden="true" />} checked={params.dirtyAir} onChange={(v) => onChange({ dirtyAir: v })} />
          <RangeSlider spec={DIRTY_AIR_GAP_RANGE} value={params.dirtyAirGapS} onChange={(v) => onChange({ dirtyAirGapS: v })} />
          <p className="m-0 mt-1 text-[11px] leading-[15px] text-ink-mute">
            Injecte à l'entrée de veine le sillage turbulent d'une monoplace roulant devant : déficit de vitesse et tourbillons font chuter l'appui. Plus l'écart est faible, plus la perte est forte.
          </p>
        </Section>

        {spec.paintable ? (
          <Section index="07" title="Sculpture" status={view.brush === 'paint' ? 'pinceau' : 'gomme'}>
            <SegmentedControl ariaLabel="Outil de sculpture" options={BRUSH_OPTIONS} value={view.brush} onChange={(v) => onViewChange({ brush: v })} />
            <div className="mt-1">
              <Slider label="Rayon de l'outil" unit="cellules" value={view.brushRadius} min={1} max={12} step={1} defaultValue={4} onChange={(v) => onViewChange({ brushRadius: v })} />
            </div>
            <p className="m-0 mb-2 text-[11px] leading-[15px] text-ink-mute">Cliquez-glissez dans la veine pour déposer ou retirer de la matière. Les efforts sont intégrés sur toute la forme.</p>
            <Button block variant="danger" icon={<Trash2 size={12} aria-hidden="true" />} onClick={() => onCommand('clearSculpt')}>
              Effacer la sculpture
            </Button>
          </Section>
        ) : null}

        <Section index={spec.paintable ? '08' : '07'} title="Simulation" status={params.paused ? 'pause' : 'active'}>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant={params.paused ? 'accent' : 'outline'}
              aria-pressed={params.paused}
              icon={params.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
              shortcut="Espace"
              onClick={() => onChange({ paused: !params.paused })}
            >
              {params.paused ? 'Reprendre' : 'Pause'}
            </Button>
            <Button className="flex-1" icon={<RotateCcw size={12} aria-hidden="true" />} shortcut="R" onClick={() => onCommand('resetFlow')}>
              Reset flux
            </Button>
          </div>
          <div className="mt-1.5">
            <RangeSlider spec={SUBSTEP_RANGE} value={params.substeps} onChange={(v) => onChange({ substeps: v })} />
          </div>
          <div className="mt-1">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[12px] leading-4 text-ink-dim">Résolution de grille</span>
              <span className="num text-[10px] text-ink-mute">{fmt(grid.nx * grid.ny, 0)} cellules</span>
            </div>
            <SegmentedControl
              ariaLabel="Résolution de grille"
              options={gridOptions}
              value={gridValue}
              onChange={(v) => {
                const next = GRID_OPTIONS.find((g) => `${g.nx}x${g.ny}` === v);
                if (next) onGridChange({ nx: next.nx, ny: next.ny });
              }}
            />
          </div>
        </Section>
      </div>

      <footer className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-line px-3">
        <span className="label-cond text-[9px]">Raccourcis</span>
        <span className="flex items-center gap-1.5 text-[10px] text-ink-mute">
          <Kbd>D</Kbd>DRS
          <Kbd>B</Kbd>Réf.
          <Kbd>1</Kbd>–<Kbd>4</Kbd>Calques
        </span>
      </footer>
    </aside>
  );
}

export default memo(ControlSidebar);
