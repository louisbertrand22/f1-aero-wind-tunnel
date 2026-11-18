import { describe, expect, it } from 'vitest';
import type { PresetId } from '../types';
import { buildGeometry, maskBounds, naca4, paintBrush, rasterizePolygons, seedFreeform } from './airfoils';
import type { GeometryInput, GeometryPolygon } from './airfoils';
import { PRESETS, rideMmPerCell } from './presets';
import type { RangeSpec } from './presets';

const GRIDS: readonly { nx: number; ny: number }[] = [
  { nx: 300, ny: 136 },
  { nx: 400, ny: 180 },
  { nx: 500, ny: 220 },
];
const POLYGON_PRESETS: readonly PresetId[] = ['rearWing', 'frontWing', 'floor'];
const DRS_STEPS: readonly number[] = [0, 0.5, 1];

function ends(range: RangeSpec | null): number[] {
  return range ? [range.min, range.max] : [0];
}

/** Every combination of range extremes (plus the defaults) for a preset on a grid. */
function setups(preset: PresetId, nx: number, ny: number): GeometryInput[] {
  const spec = PRESETS[preset];
  const out: GeometryInput[] = [];
  const drsSteps = spec.drs ? DRS_STEPS : [0];
  for (const drs of drsSteps) {
    out.push({
      nx,
      ny,
      preset,
      angleOfAttackDeg: spec.aoa?.default ?? 0,
      flapAngleDeg: spec.flap?.default ?? 0,
      rideHeightMm: spec.rideHeight?.default ?? 0,
      drs,
    });
    for (const angleOfAttackDeg of ends(spec.aoa)) {
      for (const flapAngleDeg of ends(spec.flap)) {
        for (const rideHeightMm of ends(spec.rideHeight)) {
          out.push({ nx, ny, preset, angleOfAttackDeg, flapAngleDeg, rideHeightMm, drs });
        }
      }
    }
  }
  return out;
}

function describeSetup(s: GeometryInput): string {
  return `${s.preset} ${s.nx}x${s.ny} aoa=${s.angleOfAttackDeg} flap=${s.flapAngleDeg} rh=${s.rideHeightMm} drs=${s.drs}`;
}

function rasterize(polygons: readonly GeometryPolygon[], nx: number, ny: number): Uint8Array {
  const mask = new Uint8Array(nx * ny);
  rasterizePolygons(polygons, nx, ny, mask);
  return mask;
}

function countSolid(mask: Uint8Array): number {
  let n = 0;
  for (let k = 0; k < mask.length; k++) n += mask[k];
  return n;
}

/** Smallest Chebyshev distance (cells) between the solid cells of two masks. */
function minCellDistance(a: Uint8Array, b: Uint8Array, nx: number, ny: number): number {
  const ba = maskBounds(a, nx, ny);
  const bb = maskBounds(b, nx, ny);
  if (!ba || !bb) return Infinity;
  let best = Infinity;
  for (let j = ba.y0; j <= ba.y1; j++) {
    for (let i = ba.x0; i <= ba.x1; i++) {
      if (a[i + j * nx] === 0) continue;
      const reach = Math.min(best, 12);
      const j0 = Math.max(bb.y0, j - reach);
      const j1 = Math.min(bb.y1, j + reach);
      const i0 = Math.max(bb.x0, i - reach);
      const i1 = Math.min(bb.x1, i + reach);
      for (let q = j0; q <= j1; q++) {
        for (let p = i0; p <= i1; p++) {
          if (b[p + q * nx] === 0) continue;
          const d = Math.max(Math.abs(p - i), Math.abs(q - j));
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

function yExtent(poly: GeometryPolygon): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 1; k < poly.points.length; k += 2) {
    lo = Math.min(lo, poly.points[k]);
    hi = Math.max(hi, poly.points[k]);
  }
  return hi - lo;
}

/** Debug helper: `GEOM_DEBUG=1 npx vitest run src/geometry` prints every preset as ASCII art. */
function asciiMask(mask: Uint8Array, nx: number, ny: number): string {
  const lines: string[] = [];
  for (let j = 0; j < ny; j += 2) {
    let line = '';
    for (let i = 0; i < nx; i += 2) {
      const top = mask[i + j * nx] === 1;
      const bottom = j + 1 < ny && mask[i + (j + 1) * nx] === 1;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : j + 1 >= ny - 1 ? '_' : ' ';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

describe('naca4', () => {
  it('returns a closed, finite contour with the leading edge at the origin', () => {
    const chord = 80;
    const pts = naca4(0.04, 0.4, 0.12, chord, 40);
    expect(pts.length % 2).toBe(0);
    expect(pts.length / 2).toBeGreaterThanOrEqual(60);
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      expect(Number.isFinite(pts[k])).toBe(true);
      expect(Number.isFinite(pts[k + 1])).toBe(true);
      xMin = Math.min(xMin, pts[k]);
      xMax = Math.max(xMax, pts[k]);
      yMin = Math.min(yMin, pts[k + 1]);
      yMax = Math.max(yMax, pts[k + 1]);
    }
    expect(xMin).toBeGreaterThan(-0.02 * chord);
    expect(xMin).toBeLessThanOrEqual(1e-6);
    expect(xMax).toBeCloseTo(chord, 3);
    // 12 % thick, cambered toward +y.
    expect(yMax - yMin).toBeGreaterThan(0.115 * chord);
    expect(yMax - yMin).toBeLessThan(0.135 * chord);
    expect(yMax).toBeGreaterThan(-yMin);
    // Starts at the trailing edge.
    expect(pts[0]).toBeCloseTo(chord, 3);
    expect(pts[1]).toBeCloseTo(0, 3);
  });

  it('is symmetric when uncambered', () => {
    const pts = naca4(0, 0, 0.12, 50, 30);
    let sum = 0;
    for (let k = 1; k < pts.length; k += 2) sum += pts[k];
    expect(Math.abs(sum)).toBeLessThan(1e-3);
  });
});

describe('buildGeometry', () => {
  it('yields no outline for the freeform preset', () => {
    const g = buildGeometry({ nx: 400, ny: 180, preset: 'freeform', angleOfAttackDeg: 0, flapAngleDeg: 0, rideHeightMm: 0, drs: 0 });
    expect(g.polygons).toHaveLength(0);
    expect(g.bounds).toBeNull();
    expect(g.refLengthCells).toBeCloseTo(40, 5);
  });

  for (const preset of POLYGON_PRESETS) {
    for (const { nx, ny } of GRIDS) {
      it(`${preset} stays valid over its whole setup range on ${nx}×${ny}`, () => {
        for (const setup of setups(preset, nx, ny)) {
          const tag = describeSetup(setup);
          const g = buildGeometry(setup);
          expect(g.polygons.length, tag).toBe(preset === 'rearWing' ? 2 : preset === 'frontWing' ? 4 : 1);
          expect(g.bounds, tag).not.toBeNull();
          const b = g.bounds!;
          for (const poly of g.polygons) {
            expect(poly.points.length / 2, tag).toBeGreaterThanOrEqual(60);
            for (let k = 0; k < poly.points.length; k += 2) {
              const x = poly.points[k];
              const y = poly.points[k + 1];
              expect(Number.isFinite(x) && Number.isFinite(y), tag).toBe(true);
              expect(x, tag).toBeGreaterThanOrEqual(2);
              expect(x, tag).toBeLessThanOrEqual(nx - 3);
              expect(y, tag).toBeGreaterThanOrEqual(1);
              expect(y, tag).toBeLessThanOrEqual(ny - 2);
              expect(x, tag).toBeGreaterThanOrEqual(b.x0 - 1e-3);
              expect(x, tag).toBeLessThanOrEqual(b.x1 + 1e-3);
              expect(y, tag).toBeGreaterThanOrEqual(b.y0 - 1e-3);
              expect(y, tag).toBeLessThanOrEqual(b.y1 + 1e-3);
            }
          }
          expect(g.refLengthCells, tag).toBeCloseTo(Math.max(1, b.x1 - b.x0), 3);
          expect(g.refLengthCells, tag).toBeGreaterThan(0.1 * nx);

          const mask = rasterize(g.polygons, nx, ny);
          expect(countSolid(mask), tag).toBeGreaterThan(40);
          // Protected margins stay fluid.
          for (let j = 0; j < ny; j++) {
            for (const i of [0, 1, nx - 2, nx - 1]) expect(mask[i + j * nx], tag).toBe(0);
          }
          for (let i = 0; i < nx; i++) {
            expect(mask[i], tag).toBe(0);
            expect(mask[i + (ny - 1) * nx], tag).toBe(0);
          }
          // Every element is resolved on the lattice.
          for (const poly of g.polygons) expect(countSolid(rasterize([poly], nx, ny)), tag).toBeGreaterThan(10);

          if (PRESETS[preset].rideHeight) {
            // At least three free fluid rows between the body and the road row.
            const mb = maskBounds(mask, nx, ny)!;
            expect(ny - 2 - mb.y1, tag).toBeGreaterThanOrEqual(3);
            // …and the requested clearance is honoured to within a cell.
            const want = Math.max(3, setup.rideHeightMm / rideMmPerCell(preset, nx));
            expect(ny - 1.5 - b.y1, tag).toBeGreaterThan(want - 0.01);
            expect(ny - 1.5 - b.y1, tag).toBeLessThan(want + 1);
          }
        }
      });
    }
  }

  it('keeps every slot open between neighbouring wing elements', () => {
    for (const preset of ['rearWing', 'frontWing'] as const) {
      for (const { nx, ny } of GRIDS) {
        for (const setup of setups(preset, nx, ny)) {
          const tag = describeSetup(setup);
          const g = buildGeometry(setup);
          const masks = g.polygons.map((p) => rasterize([p], nx, ny));
          for (let k = 1; k < masks.length; k++) {
            // Distance ≥ 2 ⇔ at least one fluid cell separates the two elements everywhere.
            expect(minCellDistance(masks[k - 1], masks[k], nx, ny), tag).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
  });

  it('resolves the rear-wing slot with at least three cells on the 400×180 grid', () => {
    const spec = PRESETS.rearWing;
    const g = buildGeometry({ nx: 400, ny: 180, preset: 'rearWing', angleOfAttackDeg: spec.aoa!.default, flapAngleDeg: spec.flap!.default, rideHeightMm: 0, drs: 0 });
    const main = rasterize([g.polygons[0]], 400, 180);
    const flap = rasterize([g.polygons[1]], 400, 180);
    // Chebyshev distance 4 ⇔ three fluid cells across the narrowest part of the slot.
    expect(minCellDistance(main, flap, 400, 180)).toBeGreaterThanOrEqual(4);
  });

  it('opens the DRS flap continuously: less frontal height, wider slot, only the flap moves', () => {
    for (const { nx, ny } of GRIDS) {
      const spec = PRESETS.rearWing;
      const base = { nx, ny, preset: 'rearWing' as const, angleOfAttackDeg: spec.aoa!.default, flapAngleDeg: spec.flap!.default, rideHeightMm: 0 };
      const closed = buildGeometry({ ...base, drs: 0 });
      const half = buildGeometry({ ...base, drs: 0.5 });
      const open = buildGeometry({ ...base, drs: 1 });
      expect(closed.polygons[1].movable).toBe(true);
      expect(closed.polygons[0].movable).toBe(false);
      expect(Array.from(open.polygons[0].points)).toEqual(Array.from(closed.polygons[0].points));
      const hClosed = yExtent(closed.polygons[1]);
      const hHalf = yExtent(half.polygons[1]);
      const hOpen = yExtent(open.polygons[1]);
      expect(hHalf).toBeLessThan(hClosed);
      expect(hOpen).toBeLessThan(hHalf);
      expect(hOpen).toBeLessThan(0.5 * hClosed);
      const main = rasterize([closed.polygons[0]], nx, ny);
      const gapClosed = minCellDistance(main, rasterize([closed.polygons[1]], nx, ny), nx, ny);
      const gapOpen = minCellDistance(main, rasterize([open.polygons[1]], nx, ny), nx, ny);
      expect(gapOpen).toBeGreaterThan(gapClosed + 3);
    }
  });

  it('builds downforce-producing shapes (camber toward the road, trailing edge raised)', () => {
    const g = buildGeometry({ nx: 400, ny: 180, preset: 'rearWing', angleOfAttackDeg: 10, flapAngleDeg: 36, rideHeightMm: 0, drs: 0 });
    const main = g.polygons[0].points;
    // Point 0 is the trailing edge; the leading edge is the left-most point.
    let le = 0;
    for (let k = 0; k < main.length; k += 2) if (main[k] < main[le]) le = k;
    expect(main[1]).toBeLessThan(main[le + 1]); // trailing edge higher (smaller j) than the nose
    // The flap sits above and behind the main plane.
    const flapB = buildGeometry({ nx: 400, ny: 180, preset: 'rearWing', angleOfAttackDeg: 10, flapAngleDeg: 36, rideHeightMm: 0, drs: 0 }).polygons[1];
    let fx = 0;
    let fy = 0;
    for (let k = 0; k < flapB.points.length; k += 2) {
      fx += flapB.points[k];
      fy += flapB.points[k + 1];
    }
    fx /= flapB.points.length / 2;
    fy /= flapB.points.length / 2;
    expect(fx).toBeGreaterThan(main[0] - 5);
    expect(fy).toBeLessThan(main[1]);
  });

  it('raises the diffuser exit with the diffuser angle and pitches the floor with rake', () => {
    const nx = 400;
    const ny = 180;
    const exitGap = (flapAngleDeg: number, angleOfAttackDeg: number): { front: number; rear: number } => {
      const g = buildGeometry({ nx, ny, preset: 'floor', angleOfAttackDeg, flapAngleDeg, rideHeightMm: 55, drs: 0 });
      const mask = rasterize(g.polygons, nx, ny);
      const b = maskBounds(mask, nx, ny)!;
      const lowest = (i: number): number => {
        for (let j = ny - 1; j >= 0; j--) if (mask[i + j * nx] === 1) return ny - 1.5 - j;
        return NaN;
      };
      return { front: lowest(Math.round(b.x0 + 0.35 * (b.x1 - b.x0))), rear: lowest(b.x1 - 2) };
    };
    const shallow = exitGap(6, 0);
    const steep = exitGap(22, 0);
    expect(steep.rear).toBeGreaterThan(shallow.rear + 8);
    expect(shallow.front).toBeCloseTo(steep.front, 5);
    const raked = exitGap(13, 3);
    const flat = exitGap(13, 0);
    expect(raked.rear).toBeGreaterThan(flat.rear + 2);
  });

  it('clamps out-of-range and non-finite setups instead of producing garbage', () => {
    const g = buildGeometry({ nx: 400, ny: 180, preset: 'frontWing', angleOfAttackDeg: Number.NaN, flapAngleDeg: 500, rideHeightMm: -40, drs: 7 });
    for (const poly of g.polygons) for (const v of poly.points) expect(Number.isFinite(v)).toBe(true);
    const mb = maskBounds(rasterize(g.polygons, 400, 180), 400, 180)!;
    expect(180 - 2 - mb.y1).toBeGreaterThanOrEqual(3);
  });
});

describe('rasterizePolygons', () => {
  it('fills cell nodes inside the polygon, clears previous content and unions polygons', () => {
    const nx = 40;
    const ny = 30;
    const square = (x0: number, y0: number, x1: number, y1: number): GeometryPolygon => ({ points: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]), movable: false });
    const out = new Uint8Array(nx * ny).fill(1);
    rasterizePolygons([square(9.5, 9.5, 14.5, 12.5), square(12.5, 11.5, 19.5, 15.5)], nx, ny, out);
    expect(out[10 + 10 * nx]).toBe(1);
    expect(out[14 + 12 * nx]).toBe(1);
    expect(out[19 + 15 * nx]).toBe(1);
    expect(out[9 + 10 * nx]).toBe(0);
    expect(out[15 + 10 * nx]).toBe(0);
    expect(out[5 + 5 * nx]).toBe(0);
    expect(countSolid(out)).toBe(5 * 3 + 7 * 4 - 2 * 1);
  });

  it('never fills the inlet/outlet columns nor the wall rows', () => {
    const nx = 30;
    const ny = 20;
    const out = new Uint8Array(nx * ny);
    rasterizePolygons([{ points: new Float32Array([-5, -5, nx + 5, -5, nx + 5, ny + 5, -5, ny + 5]), movable: false }], nx, ny, out);
    expect(maskBounds(out, nx, ny)).toEqual({ x0: 2, y0: 1, x1: nx - 3, y1: ny - 2 });
    expect(countSolid(out)).toBe((nx - 4) * (ny - 2));
  });
});

describe('paintBrush / seedFreeform / maskBounds', () => {
  it('paints and erases a capsule and reports whether the mask changed', () => {
    const nx = 60;
    const ny = 40;
    const mask = new Uint8Array(nx * ny);
    expect(maskBounds(mask, nx, ny)).toBeNull();
    expect(paintBrush(mask, nx, ny, 20, 20, 30, 20, 3, false)).toBe(true);
    expect(mask[25 + 20 * nx]).toBe(1);
    expect(mask[17 + 20 * nx]).toBe(1);
    expect(mask[33 + 20 * nx]).toBe(1);
    expect(mask[25 + 23 * nx]).toBe(1);
    expect(mask[25 + 24 * nx]).toBe(0);
    expect(mask[34 + 20 * nx]).toBe(0);
    expect(maskBounds(mask, nx, ny)).toEqual({ x0: 17, y0: 17, x1: 33, y1: 23 });
    // Painting the same stroke again changes nothing.
    expect(paintBrush(mask, nx, ny, 20, 20, 30, 20, 3, false)).toBe(false);
    // Erasing where there is nothing changes nothing.
    expect(paintBrush(mask, nx, ny, 50, 8, 52, 8, 2, true)).toBe(false);
    expect(paintBrush(mask, nx, ny, 25, 20, 25, 20, 2, true)).toBe(true);
    expect(mask[25 + 20 * nx]).toBe(0);
    expect(mask[20 + 20 * nx]).toBe(1);
    expect(paintBrush(mask, nx, ny, 0, 0, nx, ny, 100, true)).toBe(true);
    expect(countSolid(mask)).toBe(0);
  });

  it('respects the protected tunnel margins', () => {
    const nx = 50;
    const ny = 30;
    const mask = new Uint8Array(nx * ny);
    paintBrush(mask, nx, ny, -10, -10, nx + 10, ny + 10, 200, false);
    expect(maskBounds(mask, nx, ny)).toEqual({ x0: 2, y0: 1, x1: nx - 3, y1: ny - 2 });
    expect(paintBrush(mask, nx, ny, 0, 0, 1, 0, 0.5, false)).toBe(false);
    expect(paintBrush(mask, nx, ny, Number.NaN, 0, 1, 0, 2, false)).toBe(false);
  });

  it('seeds a cylinder for the freeform preset', () => {
    for (const { nx, ny } of GRIDS) {
      const mask = seedFreeform(nx, ny);
      expect(mask.length).toBe(nx * ny);
      const b = maskBounds(mask, nx, ny)!;
      const r = ny / 11;
      expect((b.x0 + b.x1) / 2).toBeCloseTo(0.24 * nx, 0);
      expect((b.y0 + b.y1) / 2).toBeCloseTo(0.5 * ny, 0);
      expect(b.x1 - b.x0).toBeGreaterThanOrEqual(2 * r - 2);
      expect(b.x1 - b.x0).toBeLessThanOrEqual(2 * r + 1);
      expect(Math.abs(countSolid(mask) - Math.PI * r * r)).toBeLessThan(0.12 * Math.PI * r * r);
    }
  });
});

describe.runIf(process.env.GEOM_DEBUG === '1')('debug dump', () => {
  it('prints every preset as ASCII art', () => {
    const nx = Number(process.env.GEOM_NX ?? 400);
    const ny = Math.round((nx * 180) / 400 / 2) * 2;
    for (const preset of POLYGON_PRESETS) {
      const spec = PRESETS[preset];
      const variants: GeometryInput[] = [
        { nx, ny, preset, angleOfAttackDeg: spec.aoa!.default, flapAngleDeg: spec.flap!.default, rideHeightMm: spec.rideHeight?.default ?? 0, drs: 0 },
        { nx, ny, preset, angleOfAttackDeg: spec.aoa!.max, flapAngleDeg: spec.flap!.max, rideHeightMm: spec.rideHeight?.min ?? 0, drs: spec.drs ? 1 : 0 },
        { nx, ny, preset, angleOfAttackDeg: spec.aoa!.min, flapAngleDeg: spec.flap!.min, rideHeightMm: spec.rideHeight?.max ?? 0, drs: 0 },
        { nx, ny, preset, angleOfAttackDeg: spec.aoa!.max, flapAngleDeg: spec.flap!.max, rideHeightMm: spec.rideHeight?.max ?? 0, drs: 0 },
      ];
      for (const v of variants) {
        const g = buildGeometry(v);
        console.log(`\n=== ${describeSetup(v)} — ref ${g.refLengthCells.toFixed(1)} cells ===\n${asciiMask(rasterize(g.polygons, nx, ny), nx, ny)}`);
      }
    }
    console.log(`\n=== freeform seed ===\n${asciiMask(seedFreeform(nx, ny), nx, ny)}`);
  });
});
