import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { AlertTriangle, Crosshair, Loader2, Pause, Wind } from 'lucide-react';
import type { CfdFrame } from '../hooks/useCfdWorker';
import { PRESETS } from '../geometry/presets';
import { FieldRenderer, sampleField } from '../lib/fieldRenderer';
import { legendFor, SOLID_RGB } from '../lib/colormaps';
import { TracerParticles } from '../lib/particles';
import { nozzleRows } from '../physics/smoke';
import { SPEED_OF_SOUND } from '../types';
import type { GridSize, LayerId, Telemetry, TunnelParams, TunnelStatus, ViewSettings } from '../types';

export interface WindTunnelCanvasProps {
  /** Latest worker snapshot; read from the animation frame only. */
  frameRef: RefObject<CfdFrame | null>;
  grid: GridSize;
  view: ViewSettings;
  params: TunnelParams;
  status: TunnelStatus;
  onPaint: (x0: number, y0: number, x1: number, y1: number, radius: number, erase: boolean) => void;
  onRenderFps: (fps: number) => void;
}

const LAYER_TITLES: Record<LayerId, string> = {
  pressure: 'Champ de pression · Cp',
  velocity: 'Champ de vélocité · |V|',
  vorticity: 'Vorticité · ∇×V',
  smoke: 'Fumée & lignes de courant',
};

const COLOR_DF = '#3987e5';
const COLOR_DRAG = '#d95926';
const COLOR_FLOWVIS = '#c8f53a';
const COLOR_INK = '#e9edf1';
const MONO = '"JetBrains Mono Variable", ui-monospace, monospace';
const COND = '"Barlow Condensed", "Barlow", sans-serif';
const TRACER_COUNT = 2200;
const ATM_PA = 101325;

const fmt0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt3 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

function signed(value: number, format: Intl.NumberFormat): string {
  const text = format.format(Math.abs(value));
  return `${value < 0 ? '−' : '+'}${text}`;
}

type ProbeKey = 'cp' | 'pressure' | 'speed' | 'mach' | 'reynolds' | 'angle' | 'position';

const PROBE_ROWS: readonly { key: ProbeKey; label: string }[] = [
  { key: 'cp', label: 'Cp' },
  { key: 'pressure', label: 'P statique' },
  { key: 'speed', label: 'V locale' },
  { key: 'mach', label: 'Mach' },
  { key: 'reynolds', label: 'Re local' },
  { key: 'angle', label: 'Déviation' },
  { key: 'position', label: 'x · h' },
];

interface PointerState {
  inside: boolean;
  /** CSS pixels relative to the canvas. */
  mx: number;
  my: number;
  /** Grid coordinates. */
  gx: number;
  gy: number;
  down: boolean;
  erase: boolean;
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, head: number): void {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(angle) * head * 0.6, y1 - Math.sin(angle) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(angle - 0.42) * head, y1 - Math.sin(angle - 0.42) * head);
  ctx.lineTo(x1 - Math.cos(angle + 0.42) * head, y1 - Math.sin(angle + 0.42) * head);
  ctx.closePath();
  ctx.fill();
}

/** Text on a dark plate so it stays legible over any colour map. */
function plateText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, dpr: number, align: CanvasTextAlign, accent: string): void {
  ctx.font = `600 ${11 * dpr}px ${MONO}`;
  const w = ctx.measureText(text).width;
  const padX = 5 * dpr;
  const h = 17 * dpr;
  const left = align === 'left' ? x : align === 'right' ? x - w - padX * 2 : x - w / 2 - padX;
  ctx.fillStyle = 'rgba(7, 8, 10, 0.86)';
  ctx.fillRect(left, y - h / 2, w + padX * 2, h);
  ctx.fillStyle = accent;
  ctx.fillRect(left, y - h / 2, 2 * dpr, h);
  ctx.fillStyle = COLOR_INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + padX + dpr, y + dpr * 0.5);
}

function niceLength(maxMeters: number): number {
  const candidates = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2];
  let best = candidates[0];
  for (const c of candidates) if (c <= maxMeters) best = c;
  return best;
}

export default function WindTunnelCanvas({ frameRef, grid, view, params, status, onPaint, onRenderFps }: WindTunnelCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const probeBoxRef = useRef<HTMLDivElement | null>(null);
  const probeValueRefs = useRef<Partial<Record<ProbeKey, HTMLSpanElement | null>>>({});
  const probeTitleRef = useRef<HTMLSpanElement | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  // Latest props for the animation loop (which is mounted once).
  const viewRef = useRef(view);
  const paramsRef = useRef(params);
  const gridRef = useRef(grid);
  const onPaintRef = useRef(onPaint);
  const onRenderFpsRef = useRef(onRenderFps);
  viewRef.current = view;
  paramsRef.current = params;
  gridRef.current = grid;
  onPaintRef.current = onPaint;
  onRenderFpsRef.current = onRenderFps;

  const pointerRef = useRef<PointerState>({ inside: false, mx: 0, my: 0, gx: 0, gy: 0, down: false, erase: false });

  // Fit the stage to the host while preserving the lattice aspect ratio.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => {
      const aspect = grid.nx / grid.ny;
      const availW = host.clientWidth;
      const availH = host.clientHeight;
      const width = Math.max(0, Math.floor(Math.min(availW, availH * aspect)));
      const height = Math.max(0, Math.floor(width / aspect));
      setStage((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [grid.nx, grid.ny]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const renderer = new FieldRenderer();
    const particles = new TracerParticles(TRACER_COUNT);
    const trail = document.createElement('canvas');
    const trailCtx = trail.getContext('2d');
    let lastFrameId = -1;
    let lastLayer: LayerId | null = null;
    let lastFlowVis = false;
    let lastParticles = false;
    let beltOffset = 0;
    let fpsWindowStart = performance.now();
    let fpsFrames = 0;
    let raf = 0;

    const drawForces = (t: Telemetry, cellW: number, cellH: number, W: number, H: number, dpr: number) => {
      const b = t.bodyBounds;
      if (!b || !Number.isFinite(t.copX)) return;
      const cx = (t.copX + 0.5) * cellW;
      const cy = (t.copY + 0.5) * cellH;
      const unit = H * 0.3;
      const lenDf = unit * Math.tanh(Math.abs(t.cl) / 2.2);
      const lenDrag = unit * Math.tanh(Math.abs(t.cd) / 2.2);
      const head = 8 * dpr;
      ctx.lineWidth = 2 * dpr;
      ctx.lineCap = 'butt';

      // Downforce: vertical arrow through the centre of pressure.
      if (lenDf > head) {
        const dir = t.cl >= 0 ? 1 : -1;
        let y0 = cy;
        let y1 = cy + dir * lenDf;
        if (y1 > H - 14 * dpr || y1 < 14 * dpr) {
          // Not enough room past the CoP (ground effect): let the arrow end on it.
          y0 = cy - dir * lenDf;
          y1 = cy;
        }
        ctx.strokeStyle = COLOR_DF;
        ctx.fillStyle = COLOR_DF;
        arrow(ctx, cx, y0, cx, y1, head);
        const labelY = y0 === cy ? y1 + dir * 13 * dpr : y0 - dir * 13 * dpr;
        plateText(ctx, `${t.cl >= 0 ? 'APPUI' : 'PORTANCE'} ${fmt0.format(Math.abs(t.downforceN))} N`, cx, labelY, dpr, 'center', COLOR_DF);
      }
      // Drag: horizontal arrow pointing downstream.
      if (lenDrag > head) {
        const dir = t.cd >= 0 ? 1 : -1;
        ctx.strokeStyle = COLOR_DRAG;
        ctx.fillStyle = COLOR_DRAG;
        arrow(ctx, cx, cy, cx + dir * lenDrag, cy, head);
        plateText(ctx, `TRAÎNÉE ${fmt0.format(Math.abs(t.dragN))} N`, cx + dir * (lenDrag + 8 * dpr), cy, dpr, dir > 0 ? 'left' : 'right', COLOR_DRAG);
      }

      // Centre-of-pressure target.
      const r = 6 * dpr;
      ctx.fillStyle = '#07080a';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLOR_INK;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, 0, Math.PI / 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, Math.PI, Math.PI * 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = COLOR_INK;
      ctx.lineWidth = 1.25 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Aero balance rail along the body: leading edge ↔ trailing edge.
      const x0 = (b.x0 + 0.5) * cellW;
      const x1 = (b.x1 + 0.5) * cellW;
      const above = (b.y0 + 0.5) * cellH - 16 * dpr;
      const below = (b.y1 + 0.5) * cellH + 16 * dpr;
      const railY = above > 34 * dpr ? above : Math.min(H - 30 * dpr, below);
      ctx.strokeStyle = 'rgba(233, 237, 241, 0.7)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(x0, railY);
      ctx.lineTo(x1, railY);
      ctx.moveTo(x0, railY - 4 * dpr);
      ctx.lineTo(x0, railY + 4 * dpr);
      ctx.moveTo(x1, railY - 4 * dpr);
      ctx.lineTo(x1, railY + 4 * dpr);
      ctx.stroke();
      ctx.fillStyle = COLOR_INK;
      ctx.beginPath();
      ctx.moveTo(cx, railY + 1.5 * dpr);
      ctx.lineTo(cx - 5 * dpr, railY - 7 * dpr);
      ctx.lineTo(cx + 5 * dpr, railY - 7 * dpr);
      ctx.closePath();
      ctx.fill();
      ctx.font = `600 ${10 * dpr}px ${COND}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(233, 237, 241, 0.75)';
      ctx.textAlign = 'right';
      ctx.fillText('AV', x0 - 5 * dpr, railY);
      ctx.textAlign = 'left';
      ctx.fillText('AR', x1 + 5 * dpr, railY);
      const cpLabel = `CP ${fmt0.format(t.copFrac * 100)} %`;
      const labelOnRight = cx < W - 90 * dpr;
      plateText(ctx, cpLabel, cx + (labelOnRight ? 9 : -9) * dpr, railY - 16 * dpr, dpr, labelOnRight ? 'left' : 'right', COLOR_INK);
    };

    const updateProbe = (frame: CfdFrame, p: TunnelParams, cellW: number, cellH: number, dpr: number) => {
      const box = probeBoxRef.current;
      const ptr = pointerRef.current;
      const v = viewRef.current;
      const active = v.probe && ptr.inside && !ptr.down;
      if (box) box.style.display = active ? 'block' : 'none';
      if (!active) return;

      const { nx, ny, buffers, telemetry } = frame;
      const gx = Math.min(nx - 1, Math.max(0, ptr.gx));
      const gy = Math.min(ny - 1, Math.max(0, ptr.gy));
      const cell = Math.round(gx) + Math.round(gy) * nx;
      const inSolid = buffers.solid[cell] !== 0;
      const ux = inSolid ? 0 : sampleField(buffers.ux, nx, ny, gx, gy);
      const uy = inSolid ? 0 : sampleField(buffers.uy, nx, ny, gx, gy);
      const rho = inSolid ? telemetry.rhoRef : sampleField(buffers.rho, nx, ny, gx, gy);
      const uRef = Math.max(1e-6, telemetry.uLattice);
      const ratio = Math.hypot(ux, uy) / uRef;
      const cp = (rho - telemetry.rhoRef) / 3 / (0.5 * telemetry.rhoRef * uRef * uRef);
      const speedKmh = ratio * p.speedKmh;

      // Reticle + local velocity vector.
      const cx = (gx + 0.5) * cellW;
      const cy = (gy + 0.5) * cellH;
      const r = 9 * dpr;
      ctx.strokeStyle = COLOR_FLOWVIS;
      ctx.fillStyle = COLOR_FLOWVIS;
      ctx.lineWidth = 1.25 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx - r * 1.9, cy);
      ctx.lineTo(cx - r * 0.45, cy);
      ctx.moveTo(cx + r * 0.45, cy);
      ctx.lineTo(cx + r * 1.9, cy);
      ctx.moveTo(cx, cy - r * 1.9);
      ctx.lineTo(cx, cy - r * 0.45);
      ctx.moveTo(cx, cy + r * 0.45);
      ctx.lineTo(cx, cy + r * 1.9);
      ctx.stroke();
      if (ratio > 0.03) {
        const len = Math.min(70, 26 * ratio) * dpr;
        const inv = 1 / Math.hypot(ux, uy);
        ctx.lineWidth = 1.75 * dpr;
        arrow(ctx, cx, cy, cx + ux * inv * len, cy + uy * inv * len, 6 * dpr);
      }

      // Read-out.
      const set = (key: ProbeKey, text: string) => {
        const el = probeValueRefs.current[key];
        if (el && el.textContent !== text) el.textContent = text;
      };
      if (probeTitleRef.current) probeTitleRef.current.textContent = inSolid ? 'Sonde · paroi' : 'Sonde Pitot';
      const gauge = cp * telemetry.qInf;
      set('cp', inSolid ? '—' : signed(cp, fmt3));
      set('pressure', inSolid ? '—' : `${fmt2.format((ATM_PA + gauge) / 1000)} kPa (${signed(gauge, fmt0)} Pa)`);
      set('speed', `${fmt1.format(speedKmh)} km/h`);
      set('mach', fmt3.format(speedKmh / 3.6 / SPEED_OF_SOUND));
      set('reynolds', `${fmt2.format((telemetry.reynoldsPhys * ratio) / 1e6)} ×10⁶`);
      set('angle', ratio > 0.03 ? `${signed((Math.atan2(-uy, ux) * 180) / Math.PI, fmt1)}°` : '—');
      const xMm = gx * telemetry.metersPerCell * 1000;
      const hMm = Math.max(0, ny - 1.5 - gy) * telemetry.metersPerCell * 1000;
      set('position', `${fmt0.format(xMm)} · ${fmt0.format(hMm)} mm`);

      if (box) {
        const stageW = canvas.clientWidth;
        const stageH = canvas.clientHeight;
        const bw = box.offsetWidth;
        const bh = box.offsetHeight;
        const left = ptr.mx + 22 + bw > stageW ? ptr.mx - 22 - bw : ptr.mx + 22;
        const top = Math.min(stageH - bh - 6, Math.max(6, ptr.my + 18));
        box.style.transform = `translate(${Math.max(6, left)}px, ${top}px)`;
      }
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      fpsFrames++;
      if (now - fpsWindowStart >= 500) {
        onRenderFpsRef.current((fpsFrames * 1000) / (now - fpsWindowStart));
        fpsWindowStart = now;
        fpsFrames = 0;
      }

      const W = canvas.width;
      const H = canvas.height;
      const frame = frameRef.current;
      if (!frame || W === 0 || H === 0) {
        ctx.fillStyle = '#07080a';
        ctx.fillRect(0, 0, W, H);
        return;
      }
      const v = viewRef.current;
      const p = paramsRef.current;
      const { nx, ny, buffers, telemetry } = frame;
      const dpr = W / Math.max(1, canvas.clientWidth);
      const cellW = W / nx;
      const cellH = H / ny;
      const isNew = frame.frameId !== lastFrameId;
      const steps = isNew ? frame.perf.substeps : 0;

      // 1 — scalar field.
      if (isNew || v.layer !== lastLayer || v.flowVis !== lastFlowVis) {
        renderer.render({ nx, ny, buffers, layer: v.layer, uRef: telemetry.uLattice, rhoRef: telemetry.rhoRef, flowVis: v.flowVis });
        lastLayer = v.layer;
        lastFlowVis = v.flowVis;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(renderer.canvas, 0, 0, W, H);

      // 2 — tracer streaklines on a fading layer.
      if (trailCtx) {
        if (trail.width !== W || trail.height !== H) {
          trail.width = W;
          trail.height = H;
        }
        if (v.particles) {
          if (isNew) {
            particles.advect(buffers.ux, buffers.uy, buffers.solid, nx, ny, steps);
            if (steps > 0) {
              trailCtx.globalCompositeOperation = 'destination-out';
              trailCtx.fillStyle = 'rgba(0, 0, 0, 0.085)';
              trailCtx.fillRect(0, 0, W, H);
              trailCtx.globalCompositeOperation = 'source-over';
              trailCtx.strokeStyle = v.layer === 'smoke' ? 'rgba(233, 237, 241, 0.3)' : 'rgba(240, 244, 248, 0.5)';
              trailCtx.lineWidth = Math.max(1, dpr);
              trailCtx.lineCap = 'round';
              trailCtx.beginPath();
              particles.trace(trailCtx, cellW, cellH);
              trailCtx.stroke();
            }
          }
          ctx.drawImage(trail, 0, 0);
        } else if (lastParticles) {
          trailCtx.clearRect(0, 0, W, H);
        }
        lastParticles = v.particles;
      }

      // 3 — test article: crisp vector body over the raster mask.
      if (frame.outlines.length > 0) {
        ctx.lineJoin = 'round';
        for (const outline of frame.outlines) {
          const pts = outline.points;
          if (pts.length < 6) continue;
          ctx.beginPath();
          ctx.moveTo((pts[0] + 0.5) * cellW, (pts[1] + 0.5) * cellH);
          for (let k = 2; k < pts.length; k += 2) ctx.lineTo((pts[k] + 0.5) * cellW, (pts[k + 1] + 0.5) * cellH);
          ctx.closePath();
          ctx.fillStyle = `rgb(${SOLID_RGB[0]} ${SOLID_RGB[1]} ${SOLID_RGB[2]})`;
          ctx.fill();
          if (v.flowVis) {
            // Let the paint baked in the raster shine through the vector fill.
            ctx.save();
            ctx.clip();
            ctx.globalCompositeOperation = 'lighten';
            ctx.drawImage(renderer.canvas, 0, 0, W, H);
            ctx.restore();
          }
          const drsActive = outline.movable && frame.drs > 0.02;
          ctx.strokeStyle = drsActive ? COLOR_FLOWVIS : 'rgba(233, 237, 241, 0.6)';
          ctx.lineWidth = (drsActive ? 1.75 : 1.1) * dpr;
          ctx.stroke();
        }
      }

      // 4 — road: rolling belt or symmetry plane.
      const beltH = Math.max(cellH, 6 * dpr);
      const beltY = H - beltH;
      ctx.fillStyle = '#090b0e';
      ctx.fillRect(0, beltY, W, beltH);
      if (p.movingGround) {
        beltOffset += telemetry.uLattice * steps * cellW;
        const period = 18 * dpr;
        beltOffset %= period;
        ctx.strokeStyle = 'rgba(200, 245, 58, 0.7)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (let x = beltOffset - period; x < W + period; x += period) {
          ctx.moveTo(x, beltY + beltH - dpr);
          ctx.lineTo(x + beltH * 0.9, beltY + dpr);
        }
        ctx.stroke();
        ctx.strokeStyle = 'rgba(200, 245, 58, 0.9)';
      } else {
        ctx.strokeStyle = 'rgba(154, 164, 175, 0.45)';
      }
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(0, beltY);
      ctx.lineTo(W, beltY);
      ctx.stroke();

      // 5 — smoke rake at the inlet.
      if (p.smokeEnabled && v.layer === 'smoke') {
        const rows = nozzleRows(p.smokeNozzles, p.smokeCenter, p.smokeSpread, ny);
        ctx.fillStyle = COLOR_INK;
        for (const row of rows) {
          const y = (row + 0.5) * cellH;
          ctx.beginPath();
          ctx.moveTo(0, y - 3.5 * dpr);
          ctx.lineTo(7 * dpr, y);
          ctx.lineTo(0, y + 3.5 * dpr);
          ctx.closePath();
          ctx.fill();
        }
      }

      // 6 — scale bar.
      const barMeters = niceLength((nx * telemetry.metersPerCell * 150) / Math.max(1, canvas.clientWidth));
      const barPx = (barMeters / telemetry.metersPerCell) * cellW;
      const barX1 = W - 14 * dpr;
      const barY = beltY - 12 * dpr;
      ctx.strokeStyle = COLOR_INK;
      ctx.lineWidth = 1.25 * dpr;
      ctx.beginPath();
      ctx.moveTo(barX1 - barPx, barY - 4 * dpr);
      ctx.lineTo(barX1 - barPx, barY);
      ctx.lineTo(barX1, barY);
      ctx.lineTo(barX1, barY - 4 * dpr);
      ctx.stroke();
      ctx.font = `500 ${10 * dpr}px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = COLOR_INK;
      ctx.fillText(barMeters >= 1 ? `${fmt0.format(barMeters)} m` : `${fmt0.format(barMeters * 1000)} mm`, barX1, barY - 6 * dpr);

      // 7 — force vectors and centre of pressure.
      if (v.forces && telemetry.stable) drawForces(telemetry, cellW, cellH, W, H, dpr);

      // 8 — brush cursor (sculpt mode) or Pitot probe.
      const ptr = pointerRef.current;
      const paintable = PRESETS[p.preset].paintable;
      if (paintable && ptr.inside) {
        const erasing = ptr.down ? ptr.erase : v.brush === 'erase';
        ctx.strokeStyle = erasing ? '#ff5a52' : COLOR_FLOWVIS;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash(erasing ? [4 * dpr, 3 * dpr] : []);
        ctx.beginPath();
        ctx.ellipse((ptr.gx + 0.5) * cellW, (ptr.gy + 0.5) * cellH, v.brushRadius * cellW, v.brushRadius * cellH, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      updateProbe(frame, p, cellW, cellH, dpr);

      lastFrameId = frame.frameId;
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frameRef]);

  // Back-buffer resolution follows the stage size and device pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(stage.width * dpr));
    const h = Math.max(1, Math.round(stage.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }, [stage.width, stage.height]);

  const locate = (event: ReactPointerEvent<HTMLCanvasElement>): PointerState => {
    const rect = event.currentTarget.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const g = gridRef.current;
    const ptr = pointerRef.current;
    ptr.inside = true;
    ptr.mx = mx;
    ptr.my = my;
    ptr.gx = (mx / Math.max(1, rect.width)) * g.nx - 0.5;
    ptr.gy = (my / Math.max(1, rect.height)) * g.ny - 0.5;
    return ptr;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const ptr = locate(event);
    if (!PRESETS[paramsRef.current.preset].paintable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const invert = event.button === 2 || event.shiftKey;
    ptr.down = true;
    ptr.erase = (viewRef.current.brush === 'erase') !== invert;
    onPaintRef.current(ptr.gx, ptr.gy, ptr.gx, ptr.gy, viewRef.current.brushRadius, ptr.erase);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const ptr = pointerRef.current;
    const x0 = ptr.gx;
    const y0 = ptr.gy;
    locate(event);
    if (ptr.down) onPaintRef.current(x0, y0, ptr.gx, ptr.gy, viewRef.current.brushRadius, ptr.erase);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointerRef.current.down = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handlePointerLeave = () => {
    pointerRef.current.inside = false;
    pointerRef.current.down = false;
  };

  const spec = PRESETS[params.preset];
  const legend = legendFor(view.layer);
  const cursorClass = spec.paintable ? 'cursor-none' : view.probe ? 'cursor-crosshair' : 'cursor-default';

  return (
    <div ref={hostRef} className="relative flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-hidden bg-carbon-950">
      <div className="relative border border-line" style={{ width: stage.width, height: stage.height }}>
        <canvas
          ref={canvasRef}
          className={`block h-full w-full touch-none select-none ${cursorClass}`}
          aria-label={`Veine d'essai — ${spec.label}, calque ${LAYER_TITLES[view.layer]}`}
          role="img"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onContextMenu={(event) => event.preventDefault()}
        />

        {/* Corner registration marks */}
        <span className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l border-t border-flowvis" />
        <span className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-r border-t border-flowvis" />

        {/* Layer + article caption */}
        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
          <div className="flex items-center gap-2 bg-carbon-950/85 px-2 py-1">
            <span className="h-1.5 w-1.5 bg-flowvis" />
            <span className="font-cond text-[13px] font-semibold uppercase tracking-[0.14em] text-ink">{LAYER_TITLES[view.layer]}</span>
          </div>
          <div className="w-fit bg-carbon-950/85 px-2 py-0.5 font-cond text-[11px] font-medium uppercase tracking-[0.12em] text-ink-dim">
            {spec.label} · flux → {Math.round(params.speedKmh)} km/h
          </div>
        </div>

        {/* Bench state chips */}
        <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1">
          {params.dirtyAir && (
            <div className="flex items-center gap-1.5 border border-warn/60 bg-carbon-950/85 px-2 py-1 text-warn">
              <Wind size={13} strokeWidth={2} aria-hidden />
              <span className="font-cond text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">Air sale · {params.dirtyAirGapS.toFixed(1)} s</span>
            </div>
          )}
          {status === 'paused' && (
            <div className="flex items-center gap-1.5 border border-line-strong bg-carbon-950/85 px-2 py-1 text-ink-dim">
              <Pause size={13} strokeWidth={2} aria-hidden />
              <span className="font-cond text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">Simulation figée</span>
            </div>
          )}
          {status === 'unstable' && (
            <div className="flex items-center gap-1.5 border border-loss/70 bg-carbon-950/90 px-2 py-1 text-loss">
              <AlertTriangle size={13} strokeWidth={2} aria-hidden />
              <span className="font-cond text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">Divergence numérique · relance automatique</span>
            </div>
          )}
        </div>

        {/* Colour legend */}
        {legend && (
          <div className="pointer-events-none absolute bottom-5 left-3 w-60 bg-carbon-950/85 px-2 pb-1.5 pt-1">
            <div className="label-cond mb-1 !text-ink-dim">{legend.title}</div>
            <div className="h-2 w-full border border-line-strong" style={{ background: `linear-gradient(to right, ${legend.css})` }} />
            <div className="relative mt-0.5 h-3.5">
              {legend.ticks.map((tick) => (
                <span
                  key={tick.label}
                  className="num absolute top-0 whitespace-nowrap text-[10px] text-ink"
                  style={{
                    left: `${tick.at * 100}%`,
                    transform: tick.at <= 0.01 ? 'none' : tick.at >= 0.99 ? 'translateX(-100%)' : 'translateX(-50%)',
                  }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>
        )}
        {!legend && params.smokeEnabled && (
          <div className="pointer-events-none absolute bottom-5 left-3 bg-carbon-950/85 px-2 py-1">
            <span className="label-cond !text-ink-dim">
              Râteau de {params.smokeNozzles} buse{params.smokeNozzles > 1 ? 's' : ''} · filets de fumée colorés
            </span>
          </div>
        )}

        {/* Pitot probe read-out (updated imperatively from the render loop) */}
        <div ref={probeBoxRef} className="pointer-events-none absolute left-0 top-0 hidden w-[232px] border border-flowvis/50 bg-carbon-950/92 will-change-transform" style={{ display: 'none' }}>
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1 text-flowvis">
            <Crosshair size={12} strokeWidth={2} aria-hidden />
            <span ref={probeTitleRef} className="font-cond text-[11px] font-semibold uppercase tracking-[0.14em] text-ink">
              Sonde Pitot
            </span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-px px-2 py-1.5">
            {PROBE_ROWS.map((row) => (
              <div key={row.key} className="contents">
                <dt className="label-cond !text-[10px]">{row.label}</dt>
                <dd className="num m-0 text-right text-[11px] text-ink">
                  <span
                    ref={(el) => {
                      probeValueRefs.current[row.key] = el;
                    }}
                  >
                    —
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {status === 'booting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-carbon-950">
            <div className="flex items-center gap-3 text-ink-dim">
              <Loader2 size={18} className="animate-spin text-flowvis" aria-hidden />
              <span className="font-cond text-sm font-semibold uppercase tracking-[0.16em]">Mise en route de la soufflerie…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
