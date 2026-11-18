import { describe, expect, it } from 'vitest';
import { LbmSolver } from './lbmSolver';
import { SmokeField, nozzleRows } from './smoke';

const NX = 160;
const NY = 72;

function cylinderMask(nx: number, ny: number, cx: number, cy: number, r: number): Uint8Array {
  const mask = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if ((i - cx) ** 2 + (j - cy) ** 2 < r * r) mask[i + j * nx] = 1;
    }
  }
  return mask;
}

/** Thick flat plate from (x0, y0) to (x1, y1). */
function plateMask(nx: number, ny: number, x0: number, y0: number, x1: number, y1: number, halfThickness: number): Uint8Array {
  const mask = new Uint8Array(nx * ny);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const t = Math.min(1, Math.max(0, ((i - x0) * dx + (j - y0) * dy) / len2));
      const px = x0 + t * dx;
      const py = y0 + t * dy;
      if (Math.hypot(i - px, j - py) <= halfThickness) mask[i + j * nx] = 1;
    }
  }
  return mask;
}

interface FieldStats {
  finite: boolean;
  rhoMin: number;
  rhoMax: number;
  speedMax: number;
  mass: number;
}

function fieldStats(s: LbmSolver): FieldStats {
  let finite = true;
  let rhoMin = Infinity;
  let rhoMax = -Infinity;
  let speedMax = 0;
  let mass = 0;
  for (let x = 0; x < s.size; x++) {
    const r = s.rho[x];
    const u = s.ux[x];
    const v = s.uy[x];
    if (!Number.isFinite(r) || !Number.isFinite(u) || !Number.isFinite(v)) finite = false;
    if (s.solid[x] !== 0) continue;
    if (r < rhoMin) rhoMin = r;
    if (r > rhoMax) rhoMax = r;
    const sp = Math.hypot(u, v);
    if (sp > speedMax) speedMax = sp;
    mass += r;
  }
  return { finite, rhoMin, rhoMax, speedMax, mass };
}

function expectHealthy(s: LbmSolver): FieldStats {
  const st = fieldStats(s);
  expect(st.finite).toBe(true);
  expect(st.rhoMin).toBeGreaterThan(0.7);
  expect(st.rhoMax).toBeLessThan(1.3);
  expect(st.speedMax).toBeLessThan(0.4);
  expect(s.isFinite()).toBe(true);
  return st;
}

describe('LbmSolver — stabilité numérique', () => {
  it('reste fini et borné autour d’un cylindre (600 pas, u = 0.08, ν = 0.004)', () => {
    const s = new LbmSolver(NX, NY);
    s.setSolid(cylinderMask(NX, NY, 40, 35.5, 7));
    s.setViscosity(0.004);
    s.setInletVelocity(0.08);
    s.reset();
    for (let k = 0; k < 6; k++) {
      s.step(100);
      expectHealthy(s);
    }
    expect(s.stepCount).toBe(600);
    // Velocity is exactly zero inside the body.
    const inside = 40 + 35 * NX;
    expect(s.solid[inside]).toBe(1);
    expect(s.ux[inside]).toBe(0);
    expect(s.uy[inside]).toBe(0);
  });

  it('supporte la viscosité minimale et une vitesse élevée sans diverger', () => {
    const s = new LbmSolver(NX, NY);
    s.setSolid(plateMask(NX, NY, 40, 40, 80, 30, 2));
    s.setViscosity(0); // clamped to the minimum (0.002)
    s.setInletVelocity(0.1);
    s.reset();
    s.step(800);
    const st = fieldStats(s);
    expect(st.finite).toBe(true);
    expect(s.isFinite()).toBe(true);
    expect(st.speedMax).toBeLessThan(0.4);
  });

  it('conserve la masse et l’écoulement uniforme dans une veine vide', () => {
    const s = new LbmSolver(NX, NY);
    s.setViscosity(0.01);
    s.setInletVelocity(0.06);
    s.reset();
    const before = fieldStats(s);
    s.step(400);
    const after = expectHealthy(s);
    expect(Math.abs(after.mass - before.mass) / before.mass).toBeLessThan(1e-3);
    for (let x = 0; x < s.size; x += 37) {
      expect(Math.abs(s.ux[x] - 0.06)).toBeLessThan(1e-4);
      expect(Math.abs(s.uy[x])).toBeLessThan(1e-4);
    }
    expect(s.referenceDensity()).toBeCloseTo(1, 3);
    // No body → no load.
    const f = s.takeForces();
    expect(f.fx).toBe(0);
    expect(f.fy).toBe(0);
  });

  it('reste stable avec tapis roulant et air sale', () => {
    const s = new LbmSolver(NX, NY);
    s.setSolid(plateMask(NX, NY, 50, 60, 100, 52, 2));
    s.setViscosity(0.004);
    s.setInletVelocity(0.08);
    s.setBottomBoundary('movingWall');
    s.setDirtyAir(1);
    s.reset();
    for (let k = 0; k < 8; k++) {
      s.step(100);
      expectHealthy(s);
    }
    // The synthetic wake really perturbs the inlet: velocity deficit + cross-flow.
    let meanU = 0;
    let maxV = 0;
    for (let j = 0; j < NY; j++) {
      meanU += s.ux[j * NX];
      maxV = Math.max(maxV, Math.abs(s.uy[j * NX]));
    }
    meanU /= NY;
    expect(meanU).toBeLessThan(0.08 * 0.99);
    expect(meanU).toBeGreaterThan(0.08 * 0.6);
    expect(maxV).toBeGreaterThan(0.08 * 0.01);
    // And it carries vorticity into the test section.
    const curl = new Float32Array(s.size);
    s.computeVorticity(curl);
    let maxCurl = 0;
    for (let j = 5; j < NY - 5; j++) maxCurl = Math.max(maxCurl, Math.abs(curl[20 + j * NX]));
    expect(maxCurl).toBeGreaterThan(1e-4);
  });

  it('le tapis roulant garde un écoulement uniforme (pas de couche limite au sol)', () => {
    const s = new LbmSolver(NX, NY);
    s.setViscosity(0.01);
    s.setInletVelocity(0.07);
    s.setBottomBoundary('movingWall');
    s.reset();
    s.step(300);
    expectHealthy(s);
    const road = 80 + (NY - 1) * NX;
    expect(Math.abs(s.ux[road] - 0.07)).toBeLessThan(2e-4);
  });
});

describe('LbmSolver — efforts aérodynamiques', () => {
  it('traînée positive et portance ≈ 0 sur un cylindre centré', () => {
    const s = new LbmSolver(NX, NY);
    const r = 7;
    s.setSolid(cylinderMask(NX, NY, 40, 35.5, r));
    s.setViscosity(0.01);
    s.setInletVelocity(0.08);
    s.reset();
    s.step(500);
    s.takeForces();
    s.step(500);
    const f = s.takeForces();
    expect(f.steps).toBe(500);
    expect(f.fx).toBeGreaterThan(0);
    const cd = f.fx / (0.5 * 0.08 * 0.08 * 2 * r);
    expect(cd).toBeGreaterThan(0.5);
    expect(cd).toBeLessThan(5);
    expect(Math.abs(f.fy)).toBeLessThan(0.2 * f.fx);
    // Accumulators were reset.
    const empty = s.takeForces();
    expect(empty.steps).toBe(0);
    expect(empty.fx).toBe(0);
  });

  it('un profil plat nez vers le bas génère de l’appui (fy > 0), nez vers le haut de la portance', () => {
    const run = (yLead: number, yTrail: number): { fx: number; fy: number; cop: number } => {
      const s = new LbmSolver(NX, NY);
      s.setSolid(plateMask(NX, NY, 45, yLead, 85, yTrail, 1.6));
      s.setViscosity(0.006);
      s.setInletVelocity(0.08);
      s.reset();
      s.step(600);
      s.takeForces();
      s.step(600);
      expectHealthy(s);
      const f = s.takeForces();
      return { fx: f.fx, fy: f.fy, cop: f.xFy / f.fy };
    };
    // j grows downward: leading edge lower (larger j) than trailing edge = nose down.
    const down = run(40, 31);
    expect(down.fy).toBeGreaterThan(0);
    expect(down.fx).toBeGreaterThan(0);
    // Centre of pressure sits on the plate.
    expect(down.cop).toBeGreaterThan(40);
    expect(down.cop).toBeLessThan(90);
    const up = run(31, 40);
    expect(up.fy).toBeLessThan(0);
    expect(up.fx).toBeGreaterThan(0);
  });
});

describe('LbmSolver — géométrie dynamique et champs dérivés', () => {
  it('accepte l’ajout / la suppression de cellules solides en cours de simulation', () => {
    const s = new LbmSolver(NX, NY);
    s.setViscosity(0.005);
    s.setInletVelocity(0.08);
    s.setSolid(cylinderMask(NX, NY, 40, 36, 7));
    s.reset();
    s.step(200);
    for (let k = 0; k < 10; k++) {
      // The body creeps downstream and changes size: cells are freed and filled.
      s.setSolid(cylinderMask(NX, NY, 40 + k, 36 + (k % 3), 7 - (k % 2)));
      s.step(40);
      expectHealthy(s);
    }
    // Freed cells restart at rest with a sane density.
    const before = Uint8Array.from(s.solid);
    s.setSolid(new Uint8Array(NX * NY));
    for (let x = 0; x < s.size; x++) {
      if (before[x] === 0) continue;
      expect(s.solid[x]).toBe(0);
      expect(s.ux[x]).toBe(0);
      expect(s.rho[x]).toBeGreaterThan(0.8);
      expect(s.rho[x]).toBeLessThan(1.2);
    }
    s.step(200);
    expectHealthy(s);
  });

  it('garde les colonnes d’entrée et de sortie ouvertes', () => {
    const s = new LbmSolver(NX, NY);
    const full = new Uint8Array(NX * NY);
    for (let j = 20; j < 30; j++) {
      full[j * NX] = 1;
      full[NX - 1 + j * NX] = 1;
      full[80 + j * NX] = 1;
    }
    s.setSolid(full);
    expect(s.solid[20 * NX]).toBe(0);
    expect(s.solid[NX - 1 + 20 * NX]).toBe(0);
    expect(s.solid[80 + 20 * NX]).toBe(1);
    expect(() => s.setSolid(new Uint8Array(10))).toThrow();
  });

  it('calcule une vorticité finie, nulle dans les solides et sur les bords', () => {
    const s = new LbmSolver(NX, NY);
    s.setSolid(cylinderMask(NX, NY, 40, 34, 7));
    s.setViscosity(0.004);
    s.setInletVelocity(0.08);
    s.reset();
    s.step(1200);
    const curl = new Float32Array(s.size);
    s.computeVorticity(curl);
    let maxAbs = 0;
    for (let x = 0; x < s.size; x++) {
      expect(Number.isFinite(curl[x])).toBe(true);
      if (s.solid[x] !== 0) expect(curl[x]).toBe(0);
      maxAbs = Math.max(maxAbs, Math.abs(curl[x]));
    }
    for (let i = 0; i < NX; i++) {
      expect(curl[i]).toBe(0);
      expect(curl[i + (NY - 1) * NX]).toBe(0);
    }
    expect(maxAbs).toBeGreaterThan(1e-3);
  });

  it('reset() repart de l’écoulement uniforme en conservant le masque', () => {
    const s = new LbmSolver(NX, NY);
    const mask = cylinderMask(NX, NY, 40, 36, 6);
    s.setSolid(mask);
    s.setInletVelocity(0.05);
    s.step(50);
    s.reset();
    expect(s.stepCount).toBe(0);
    expect(s.inletVelocity).toBeCloseTo(0.05, 6);
    for (let x = 0; x < s.size; x += 11) {
      expect(s.solid[x]).toBe(mask[x]);
      expect(s.ux[x]).toBeCloseTo(mask[x] !== 0 ? 0 : 0.05, 6);
      expect(s.rho[x]).toBeCloseTo(1, 6);
    }
  });
});

describe('SmokeField', () => {
  it('place les buses de façon ordonnée dans la veine', () => {
    const rows = nozzleRows(8, 0.5, 0.6, NY);
    expect(rows).toHaveLength(8);
    for (let k = 0; k < rows.length; k++) {
      expect(rows[k]).toBeGreaterThanOrEqual(2);
      expect(rows[k]).toBeLessThanOrEqual(NY - 3);
      if (k > 0) expect(rows[k]).toBeGreaterThan(rows[k - 1]);
    }
    expect(nozzleRows(0, 0.5, 0.6, NY)).toHaveLength(0);
    // Symmetric rake around the requested centre.
    expect((rows[0] + rows[7]) / 2).toBeCloseTo(0.5 * NY - 0.5, 5);
  });

  it('reste dans [0, 1], transporte la fumée vers l’aval et s’annule dans les solides', () => {
    const n = NX * NY;
    const ux = new Float32Array(n).fill(0.08);
    const uy = new Float32Array(n);
    const solid = new Uint8Array(n);
    const rows = nozzleRows(6, 0.5, 0.7, NY);
    // A block in the path of the third filament.
    const jBlock = Math.round(rows[2]);
    for (let j = jBlock - 2; j <= jBlock + 2; j++) {
      for (let i = 90; i < 96; i++) {
        solid[i + j * NX] = 1;
        ux[i + j * NX] = 0;
      }
    }
    const smoke = new SmokeField(NX, NY);
    smoke.setNozzles(6, 0.5, 0.7);
    for (let k = 0; k < 260; k++) smoke.step(ux, uy, solid, 8, true);

    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < smoke.rgb.length; k++) {
      const v = smoke.rgb[k];
      expect(Number.isFinite(v)).toBe(true);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(0.9);

    const brightness = (i: number, j: number): number => {
      const o = (i + j * NX) * 3;
      return Math.max(smoke.rgb[o], smoke.rgb[o + 1], smoke.rgb[o + 2]);
    };
    // The first filament crossed the whole tunnel and is still crisp.
    const j0 = Math.round(rows[0]);
    expect(brightness(NX - 20, j0)).toBeGreaterThan(0.5);
    // Clear air between two filaments stays clear.
    const jMid = Math.round((rows[0] + rows[1]) / 2);
    expect(brightness(NX - 20, jMid)).toBeLessThan(0.05);
    // Nothing inside the solid block.
    expect(brightness(92, jBlock)).toBe(0);

    // Without injection the tunnel flushes itself.
    for (let k = 0; k < 400; k++) smoke.step(ux, uy, solid, 8, false);
    expect(brightness(NX - 20, j0)).toBeLessThan(0.01);

    smoke.step(ux, uy, solid, 8, true);
    smoke.clear();
    expect(smoke.rgb.every((v) => v === 0)).toBe(true);
  });
});
