import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import ABComparator from './components/ABComparator';
import ControlSidebar from './components/ControlSidebar';
import HistoryChart from './components/HistoryChart';
import TelemetryHeader from './components/TelemetryHeader';
import WindTunnelCanvas from './components/WindTunnelCanvas';
import { DEFAULT_PARAMS, PRESETS } from './geometry/presets';
import { useCfdWorker } from './hooks/useCfdWorker';
import { DEFAULT_GRID, DEFAULT_VIEW, G0 } from './types';
import type { Baseline, GridSize, LayerId, TunnelParams, ViewSettings } from './types';

const LAYER_KEYS: Record<string, LayerId> = {
  Digit1: 'pressure',
  Digit2: 'velocity',
  Digit3: 'vorticity',
  Digit4: 'smoke',
  Numpad1: 'pressure',
  Numpad2: 'velocity',
  Numpad3: 'vorticity',
  Numpad4: 'smoke',
};

/** Seconds of history averaged into a reference run. */
const BASELINE_WINDOW_S = 1.5;

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox' && target.type !== 'radio';
}

export default function App() {
  const [params, setParams] = useState<TunnelParams>(DEFAULT_PARAMS);
  const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
  const [grid, setGrid] = useState<GridSize>(DEFAULT_GRID);
  const [baseline, setBaseline] = useState<Baseline | null>(null);

  const tunnel = useCfdWorker(grid, params);
  const { telemetry, history, sendCommand } = tunnel;

  const patchParams = useCallback((patch: Partial<TunnelParams>) => {
    setParams((prev) => ({ ...prev, ...patch }));
  }, []);
  const patchView = useCallback((patch: Partial<ViewSettings>) => {
    setView((prev) => ({ ...prev, ...patch }));
  }, []);

  // Refs so the keyboard handler and capture callback always see fresh values.
  const paramsRef = useRef(params);
  const telemetryRef = useRef(telemetry);
  paramsRef.current = params;
  telemetryRef.current = telemetry;

  const captureBaseline = useCallback(() => {
    const live = telemetryRef.current;
    if (!live) return;
    const p = paramsRef.current;
    const spec = PRESETS[p.preset];
    // Average the last moments of the run: vortex shedding makes any single sample noisy.
    const mean = history.mean(BASELINE_WINDOW_S);
    const averaged = mean ? { ...live, downforceN: mean.downforceN, downforceKgf: mean.downforceN / G0, dragN: mean.dragN, ld: mean.ld } : live;
    const drsLabel = spec.drs ? ` · DRS ${p.drsOpen ? 'ouvert' : 'fermé'}` : '';
    setBaseline({
      label: `${spec.shortLabel} · ${Math.round(p.speedKmh)} km/h${drsLabel}`,
      capturedAt: Date.now(),
      params: p,
      telemetry: averaged,
    });
  }, [history]);

  const clearBaseline = useCallback(() => setBaseline(null), []);

  // Pit-wall keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTextEntry(event.target)) return;
      const layer = LAYER_KEYS[event.code];
      if (layer) {
        setView((prev) => ({ ...prev, layer }));
        return;
      }
      switch (event.code) {
        case 'KeyD':
          if (PRESETS[paramsRef.current.preset].drs) setParams((prev) => ({ ...prev, drsOpen: !prev.drsOpen }));
          break;
        case 'Space':
          // Let focused buttons keep their native activation.
          if (event.target instanceof HTMLButtonElement) return;
          event.preventDefault();
          setParams((prev) => ({ ...prev, paused: !prev.paused }));
          break;
        case 'KeyR':
          sendCommand('resetFlow');
          break;
        case 'KeyB':
          captureBaseline();
          break;
        case 'KeyF':
          setView((prev) => ({ ...prev, flowVis: !prev.flowVis }));
          break;
        case 'KeyA':
          setParams((prev) => ({ ...prev, dirtyAir: !prev.dirtyAir }));
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [captureBaseline, sendCommand]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-carbon-950 text-ink">
      <TelemetryHeader telemetry={telemetry} perf={tunnel.perf} params={params} drsPosition={tunnel.drsPosition} baseline={baseline} status={tunnel.status} />

      {tunnel.error && (
        <div role="alert" className="flex items-center gap-2 border-b border-loss/60 bg-carbon-900 px-4 py-1.5 text-loss">
          <AlertTriangle size={14} aria-hidden />
          <span className="font-cond text-xs font-semibold uppercase tracking-[0.12em] text-ink">Erreur du solveur — {tunnel.error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ControlSidebar params={params} onChange={patchParams} view={view} onViewChange={patchView} onCommand={sendCommand} grid={grid} onGridChange={setGrid} />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section aria-label="Veine d'essai" className="min-h-0 flex-1 p-3">
            <WindTunnelCanvas
              frameRef={tunnel.frameRef}
              grid={grid}
              view={view}
              params={params}
              status={tunnel.status}
              onPaint={tunnel.paint}
              onRenderFps={tunnel.reportRenderFps}
            />
          </section>

          <section aria-label="Télémétrie historique et comparateur" className="flex h-[214px] shrink-0 border-t border-line">
            <div className="min-w-0 flex-1">
              <HistoryChart history={history} baseline={baseline} paused={params.paused} />
            </div>
            <div className="w-[320px] shrink-0 border-l border-line">
              <ABComparator telemetry={telemetry} baseline={baseline} params={params} onCapture={captureBaseline} onClear={clearBaseline} />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
