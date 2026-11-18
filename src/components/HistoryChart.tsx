import { memo, useEffect, useRef, useState } from 'react';
import { Activity, Pause } from 'lucide-react';
import type { Baseline } from '../types';
import type { HistoryBuffer, HistoryChannel } from '../lib/history';
import { MINUS, NNBSP, fmt } from '../lib/format';
import { TOKENS } from './ui/tokens';

export interface HistoryChartProps {
  history: HistoryBuffer;
  baseline: Baseline | null;
  paused: boolean;
}

/** Sliding window shown on the shared time axis, seconds. */
const WINDOW_S = 30;
const AXIS_H = 16;
const PAD_L = 46;
const PAD_R = 96;
const PAD_T = 1;

interface BandSpec {
  channel: HistoryChannel;
  label: string;
  unit: string;
  color: string;
  digits: number;
  /** Smallest Y span ever shown, so sensor noise is not blown up to full height. */
  minSpan: number;
}

const BANDS: readonly BandSpec[] = [
  { channel: 'downforceN', label: 'APPUI', unit: 'N', color: TOKENS.seriesDf, digits: 0, minSpan: 40 },
  { channel: 'dragN', label: 'TRAÎNÉE', unit: 'N', color: TOKENS.seriesDrag, digits: 0, minSpan: 20 },
  { channel: 'ld', label: 'FINESSE', unit: 'L/D', color: TOKENS.seriesLd, digits: 2, minSpan: 0.4 },
];

interface Scale {
  lo: number;
  hi: number;
  ready: boolean;
}

function baselineValue(baseline: Baseline | null, channel: HistoryChannel): number {
  if (!baseline) return Number.NaN;
  const t = baseline.telemetry;
  return channel === 'downforceN' ? t.downforceN : channel === 'dragN' ? t.dragN : t.ld;
}

/** 1 / 2 / 5 × 10ⁿ step giving roughly `target` intervals over `span`. */
function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function withAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Index of the first sample with time ≥ t (binary search over the ring). */
function lowerBound(history: HistoryBuffer, t: number): number {
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (history.timeAt(mid) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Rolling real-time telemetry strip chart. Three stacked bands (small
 * multiples) share one sliding time axis — never a dual Y axis. Drawn on a
 * DPI-aware 2D canvas from its own animation frame, straight from the ring
 * buffer: no React re-render per sample.
 */
function HistoryChart({ history, baseline, paused }: HistoryChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef({ history, baseline });
  const dirtyRef = useRef(true);
  const [empty, setEmpty] = useState(history.length < 2);

  useEffect(() => {
    liveRef.current = { history, baseline };
    dirtyRef.current = true;
  }, [history, baseline]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let lastVersion = -1;
    let lastHistory: HistoryBuffer | null = null;
    let hoverX: number | null = null;
    let wasEmpty: boolean | null = null;
    const scales: Scale[] = BANDS.map(() => ({ lo: 0, hi: 1, ready: false }));

    const resize = (): void => {
      const rect = wrap.getBoundingClientRect();
      const nextDpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (w === width && h === height && nextDpr === dpr) return;
      width = w;
      height = h;
      dpr = nextDpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      dirtyRef.current = true;
    };

    /** Returns true while a Y scale is still easing toward its target. */
    const draw = (): boolean => {
      const { history: hist, baseline: base } = liveRef.current;
      const n = hist.length;
      let animating = false;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padR = width < 420 ? 72 : PAD_R;
      const x0 = PAD_L;
      const x1 = Math.max(x0 + 20, width - padR);
      const plotW = x1 - x0;
      const bandH = (height - AXIS_H - PAD_T) / BANDS.length;
      const tEnd = n > 0 ? hist.timeAt(n - 1) : 0;
      const tStart = tEnd - WINDOW_S;
      const xOf = (t: number): number => x1 - ((tEnd - t) / WINDOW_S) * plotW;
      // One sample before the window keeps the curve continuous at the left edge.
      const first = n > 0 ? Math.max(0, lowerBound(hist, tStart) - 1) : 0;

      // Hover → nearest sample.
      let hoverIdx = -1;
      if (hoverX !== null && n >= 2 && hoverX >= x0 - 4 && hoverX <= x1 + 4) {
        const tHover = tEnd - ((x1 - hoverX) / plotW) * WINDOW_S;
        const k = Math.min(n - 1, Math.max(first, lowerBound(hist, tHover)));
        hoverIdx = k > first && Math.abs(hist.timeAt(k - 1) - tHover) < Math.abs(hist.timeAt(k) - tHover) ? k - 1 : k;
        if (hist.timeAt(hoverIdx) < tStart) hoverIdx = -1;
      }

      // Vertical time grid shared by the three bands.
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(TOKENS.line, 0.7);
      ctx.beginPath();
      for (let s = 0; s <= WINDOW_S; s += 10) {
        const x = Math.round(x1 - (s / WINDOW_S) * plotW) + 0.5;
        ctx.moveTo(x, PAD_T);
        ctx.lineTo(x, PAD_T + bandH * BANDS.length);
      }
      ctx.stroke();

      for (let b = 0; b < BANDS.length; b++) {
        const band = BANDS[b];
        const scale = scales[b];
        const top = PAD_T + b * bandH;
        const bottom = top + bandH;
        const innerTop = top + 7;
        const innerBottom = bottom - 5;
        const ref = baselineValue(base, band.channel);
        const hasRef = Number.isFinite(ref);

        // Target range from the visible samples (+ the reference line).
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let k = first; k < n; k++) {
          const v = hist.valueAt(band.channel, k);
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hasRef) {
          if (ref < lo) lo = ref;
          if (ref > hi) hi = ref;
        }
        if (lo > hi) {
          lo = 0;
          hi = band.minSpan;
        }
        let span = hi - lo;
        if (span < band.minSpan) {
          const mid = (lo + hi) / 2;
          lo = mid - band.minSpan / 2;
          hi = mid + band.minSpan / 2;
          span = band.minSpan;
        }
        const tLo = lo - span * 0.12;
        const tHi = hi + span * 0.12;
        if (!scale.ready) {
          scale.lo = tLo;
          scale.hi = tHi;
          scale.ready = true;
        } else {
          // Ease toward the target: quick to open up, slow to tighten.
          const range = Math.max(1e-9, scale.hi - scale.lo);
          scale.lo += (tLo - scale.lo) * (tLo < scale.lo ? 0.3 : 0.06);
          scale.hi += (tHi - scale.hi) * (tHi > scale.hi ? 0.3 : 0.06);
          if (Math.abs(tLo - scale.lo) + Math.abs(tHi - scale.hi) > range * 0.003) animating = true;
        }
        const sLo = scale.lo;
        const sSpan = Math.max(1e-9, scale.hi - scale.lo);
        const yOf = (v: number): number => innerBottom - ((v - sLo) / sSpan) * (innerBottom - innerTop);

        // Band rule.
        ctx.strokeStyle = TOKENS.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(bottom) + 0.5);
        ctx.lineTo(width, Math.round(bottom) + 0.5);
        ctx.stroke();

        // Y ticks (2–3 per band), labels in the left gutter.
        const step = niceStep(sSpan, 2.4);
        const tickDigits = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
        ctx.font = `500 9px ${TOKENS.fontMono}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let v = Math.ceil(sLo / step) * step; v <= scale.hi; v += step) {
          const y = yOf(v);
          if (y < top + 6 || y > bottom - 4) continue;
          const yy = Math.round(y) + 0.5;
          ctx.strokeStyle = withAlpha(TOKENS.line, 0.85);
          ctx.beginPath();
          ctx.moveTo(x0, yy);
          ctx.lineTo(x1, yy);
          ctx.stroke();
          ctx.fillStyle = TOKENS.inkMute;
          ctx.fillText(fmt(v, tickDigits), x0 - 6, yy);
        }

        // Clip the data ink to the plot area of the band.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, top + 1, plotW + 1, bandH - 1);
        ctx.clip();

        // Reference run (dashed, timing purple).
        if (hasRef) {
          const y = Math.round(yOf(ref)) + 0.5;
          ctx.strokeStyle = TOKENS.reference;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (n - first >= 2) {
          // Curve.
          ctx.beginPath();
          let started = false;
          let firstX = x0;
          let lastX = x0;
          for (let k = first; k < n; k++) {
            const v = hist.valueAt(band.channel, k);
            if (!Number.isFinite(v)) continue;
            const x = xOf(hist.timeAt(k));
            const y = yOf(v);
            if (!started) {
              ctx.moveTo(x, y);
              firstX = x;
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
            lastX = x;
          }
          if (started) {
            ctx.strokeStyle = band.color;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
            // Soft wash under the curve.
            ctx.lineTo(lastX, bottom);
            ctx.lineTo(firstX, bottom);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, top, 0, bottom);
            grad.addColorStop(0, withAlpha(band.color, 0.2));
            grad.addColorStop(1, withAlpha(band.color, 0.02));
            ctx.fillStyle = grad;
            ctx.fill();
          }
        }
        ctx.restore();

        const latest = n > 0 ? hist.valueAt(band.channel, n - 1) : Number.NaN;

        // Head marker on the newest sample.
        if (n >= 2 && Number.isFinite(latest)) {
          const y = Math.min(bottom - 3, Math.max(top + 3, yOf(latest)));
          ctx.beginPath();
          ctx.arc(x1, y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = TOKENS.carbon900;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x1, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = band.color;
          ctx.fill();
        }

        // Direct label + live value in the right gutter (text in ink, identity on the swatch).
        const gx = x1 + 12;
        ctx.fillStyle = band.color;
        ctx.fillRect(gx, top + 11, 10, 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `600 11px ${TOKENS.fontCond}`;
        ctx.fillStyle = TOKENS.inkDim;
        ctx.fillText(band.label, gx + 15, top + 16);
        const shown = hoverIdx >= 0 ? hist.valueAt(band.channel, hoverIdx) : latest;
        ctx.font = `600 13px ${TOKENS.fontMono}`;
        ctx.fillStyle = TOKENS.ink;
        const valueText = fmt(shown, band.digits);
        ctx.fillText(valueText, gx, top + 33);
        const vw = ctx.measureText(valueText).width;
        ctx.font = `500 9px ${TOKENS.fontMono}`;
        ctx.fillStyle = TOKENS.inkMute;
        ctx.fillText(band.unit, gx + vw + 4, top + 33);
        if (hasRef && bandH >= 50) {
          ctx.strokeStyle = TOKENS.reference;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(gx, top + 43.5);
          ctx.lineTo(gx + 10, top + 43.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = TOKENS.inkMute;
          ctx.fillText(`réf${NNBSP}${fmt(ref, band.digits)}`, gx + 15, top + 46.5);
        }

        // Hover marker on this band.
        if (hoverIdx >= 0) {
          const v = hist.valueAt(band.channel, hoverIdx);
          if (Number.isFinite(v)) {
            const x = xOf(hist.timeAt(hoverIdx));
            const y = Math.min(bottom - 3, Math.max(top + 3, yOf(v)));
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = TOKENS.carbon900;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fillStyle = band.color;
            ctx.fill();
          }
        }
      }

      // Left plot edge.
      ctx.strokeStyle = TOKENS.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, PAD_T);
      ctx.lineTo(x0 + 0.5, PAD_T + bandH * BANDS.length);
      ctx.stroke();

      // Shared time axis.
      const axisY = height - AXIS_H / 2 + 1;
      ctx.font = `500 9px ${TOKENS.fontMono}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TOKENS.inkMute;
      for (let s = 10; s <= WINDOW_S; s += 10) {
        const x = x1 - (s / WINDOW_S) * plotW;
        ctx.textAlign = s === WINDOW_S ? 'left' : 'center';
        ctx.fillText(`${MINUS}${s}${NNBSP}s`, s === WINDOW_S ? x + 2 : x, axisY);
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = TOKENS.inkDim;
      ctx.fillText('maintenant', x1, axisY);
      ctx.textAlign = 'left';
      ctx.font = `600 10px ${TOKENS.fontCond}`;
      ctx.fillStyle = TOKENS.inkMute;
      ctx.fillText(`FENÊTRE ${WINDOW_S}${NNBSP}S`, x1 + 12, axisY);

      // Crosshair + tooltip.
      if (hoverIdx >= 0) {
        const tH = hist.timeAt(hoverIdx);
        const x = Math.round(xOf(tH)) + 0.5;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.strokeStyle = TOKENS.lineStrong;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, PAD_T);
        ctx.lineTo(x, PAD_T + bandH * BANDS.length);
        ctx.stroke();
        ctx.restore();

        const rows = BANDS.map((band) => ({ band, text: fmt(hist.valueAt(band.channel, hoverIdx), band.digits) }));
        const boxW = 136;
        const rowH = 15;
        const boxH = 20 + rows.length * rowH + 5;
        const bx = x + 10 + boxW > x1 ? x - 10 - boxW : x + 10;
        const by = Math.max(2, Math.min(height - AXIS_H - boxH - 2, PAD_T + (bandH * BANDS.length - boxH) / 2));
        ctx.fillStyle = TOKENS.carbon800;
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeStyle = TOKENS.lineStrong;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.font = `600 10px ${TOKENS.fontCond}`;
        ctx.fillStyle = TOKENS.inkMute;
        ctx.fillText('INSTANT', bx + 8, by + 13);
        ctx.textAlign = 'right';
        ctx.font = `500 10px ${TOKENS.fontMono}`;
        ctx.fillStyle = TOKENS.inkDim;
        const dt = tEnd - tH;
        ctx.fillText(dt < 0.05 ? 'maintenant' : `${MINUS}${fmt(dt, 1)}${NNBSP}s`, bx + boxW - 8, by + 13);
        rows.forEach((row, i) => {
          const y = by + 20 + i * rowH + 10;
          ctx.fillStyle = row.band.color;
          ctx.fillRect(bx + 8, y - 5, 8, 2);
          ctx.textAlign = 'left';
          ctx.font = `600 10px ${TOKENS.fontCond}`;
          ctx.fillStyle = TOKENS.inkDim;
          ctx.fillText(row.band.label, bx + 21, y);
          ctx.textAlign = 'right';
          ctx.font = `600 11px ${TOKENS.fontMono}`;
          ctx.fillStyle = TOKENS.ink;
          const unitW = 22;
          ctx.fillText(row.text, bx + boxW - 8 - unitW, y);
          ctx.textAlign = 'left';
          ctx.font = `500 9px ${TOKENS.fontMono}`;
          ctx.fillStyle = TOKENS.inkMute;
          ctx.fillText(row.band.unit, bx + boxW - 8 - unitW + 4, y);
        });
      }

      return animating;
    };

    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const hist = liveRef.current.history;
      if (hist !== lastHistory) {
        lastHistory = hist;
        lastVersion = -1;
        for (const s of scales) s.ready = false;
      }
      if (hist.version !== lastVersion) {
        lastVersion = hist.version;
        dirtyRef.current = true;
      }
      const isEmpty = hist.length < 2;
      if (isEmpty !== wasEmpty) {
        wasEmpty = isEmpty;
        setEmpty(isEmpty);
        if (isEmpty) for (const s of scales) s.ready = false;
      }
      if (!dirtyRef.current || width <= 1 || height <= 1) return;
      dirtyRef.current = draw();
    };

    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      hoverX = e.clientX - rect.left;
      dirtyRef.current = true;
    };
    const onLeave = (): void => {
      hoverX = null;
      dirtyRef.current = true;
    };

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) dirtyRef.current = true;
    });
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full min-h-[120px] w-full min-w-0 overflow-hidden bg-carbon-900">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Historique glissant sur ${WINDOW_S} secondes : appui, traînée et finesse${baseline ? ', avec le run de référence en pointillés' : ''}`}
        className="absolute top-0 left-0 block cursor-crosshair"
      />
      {empty ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 pr-[96px] pl-[46px]">
          <Activity size={16} aria-hidden="true" className="text-ink-mute" />
          <span className="label-cond text-ink-dim">En attente de données…</span>
          <span className="text-[11px] text-ink-mute">Le tracé démarre dès les premières mesures du banc.</span>
        </div>
      ) : null}
      {paused && !empty ? (
        <span className="pointer-events-none absolute top-1.5 left-[54px] flex items-center gap-1 border border-warn/60 bg-carbon-900 px-1.5 py-[2px] font-cond text-[10px] leading-none font-semibold tracking-[0.1em] text-warn uppercase">
          <Pause size={9} aria-hidden="true" />
          Acquisition figée
        </span>
      ) : null}
    </div>
  );
}

export default memo(HistoryChart);
