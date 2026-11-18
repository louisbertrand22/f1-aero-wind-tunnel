import type { LayerId } from '../types';
import type { FrameBuffers } from '../workers/protocol';
import {
  CP_PRESSURE_MAX,
  CP_SUCTION_MAX,
  FLOWVIS_RGB,
  PRESSURE_MAP,
  SMOKE_BG_RGB,
  SOLID_RGB,
  VELOCITY_MAP,
  VELOCITY_RATIO_MAX,
  VORTICITY_MAP,
  VORTICITY_SAT,
  packRgb,
} from './colormaps';

export interface FieldRenderInput {
  nx: number;
  ny: number;
  buffers: FrameBuffers;
  layer: LayerId;
  /** Free-stream lattice velocity. */
  uRef: number;
  /** Lattice density at free-stream static pressure. */
  rhoRef: number;
  /** Tint solid cells with the accumulated flow-vis paint. */
  flowVis: boolean;
}

/**
 * Software rasteriser for the scalar layers.
 *
 * The physical field is bilinearly interpolated *before* colour mapping onto
 * an image `scale`× finer than the lattice (interpolating data, not colours,
 * keeps iso-contours of the diverging maps exact). Next to a wall the
 * interpolation weights of solid cells are dropped so the surface pressure is
 * not diluted by the meaningless values stored inside the body, and the
 * solid/fluid frontier is traced at 50 % interpolated coverage, which turns
 * the staircase of the mask into smooth sub-cell edges. The GPU then
 * up-samples that image to device pixels with smoothing.
 */
export class FieldRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private pixels: Uint32Array | null = null;
  private nx = 0;
  private ny = 0;
  private scale = 0;
  // Per-column / per-row interpolation tables.
  private i0 = new Int32Array(0);
  private i1 = new Int32Array(0);
  private fx = new Float32Array(0);
  private j0 = new Int32Array(0);
  private j1 = new Int32Array(0);
  private fy = new Float32Array(0);

  constructor() {
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponible');
    this.ctx = ctx;
  }

  private ensure(nx: number, ny: number, scale: number): void {
    if (nx === this.nx && ny === this.ny && scale === this.scale && this.image) return;
    this.nx = nx;
    this.ny = ny;
    this.scale = scale;
    const w = nx * scale;
    const h = ny * scale;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.i0 = new Int32Array(w);
    this.i1 = new Int32Array(w);
    this.fx = new Float32Array(w);
    this.j0 = new Int32Array(h);
    this.j1 = new Int32Array(h);
    this.fy = new Float32Array(h);
    for (let px = 0; px < w; px++) {
      // Cell centres sit at integer grid coordinates.
      const g = Math.min(nx - 1, Math.max(0, (px + 0.5) / scale - 0.5));
      const a = Math.min(nx - 1, Math.floor(g));
      this.i0[px] = a;
      this.i1[px] = Math.min(nx - 1, a + 1);
      this.fx[px] = g - a;
    }
    for (let py = 0; py < h; py++) {
      const g = Math.min(ny - 1, Math.max(0, (py + 0.5) / scale - 0.5));
      const a = Math.min(ny - 1, Math.floor(g));
      this.j0[py] = a;
      this.j1[py] = Math.min(ny - 1, a + 1);
      this.fy[py] = g - a;
    }
  }

  render(input: FieldRenderInput, scale = 2): HTMLCanvasElement {
    const { nx, ny, buffers, layer } = input;
    this.ensure(nx, ny, scale);
    const pixels = this.pixels;
    const image = this.image;
    if (!pixels || !image) return this.canvas;

    const { ux, uy, rho, curl, smoke, flowVis, solid } = buffers;
    const w = nx * scale;
    const h = ny * scale;
    const { i0, i1, fx, j0, j1, fy } = this;

    const uRef = Math.max(1e-6, input.uRef);
    const rhoRef = input.rhoRef > 0 ? input.rhoRef : 1;
    // Cp = (p − p∞) / q∞ with p = ρ/3.
    const cpScale = 1 / 3 / (0.5 * rhoRef * uRef * uRef);
    const cpNeg = 127.5 / CP_SUCTION_MAX;
    const cpPos = 127.5 / CP_PRESSURE_MAX;
    const velScale = 255 / (VELOCITY_RATIO_MAX * uRef);
    const curlScale = 1 / (VORTICITY_SAT * uRef);
    const pressureLut = PRESSURE_MAP.lut;
    const velocityLut = VELOCITY_MAP.lut;
    const vorticityLut = VORTICITY_MAP.lut;
    const showPaint = input.flowVis;
    const [sr, sg, sb] = SOLID_RGB;
    const [pr, pg, pb] = FLOWVIS_RGB;
    const solidColor = packRgb(sr, sg, sb);
    const [br, bg, bb] = SMOKE_BG_RGB;
    const mode = layer === 'pressure' ? 0 : layer === 'velocity' ? 1 : layer === 'vorticity' ? 2 : 3;

    let p = 0;
    for (let py = 0; py < h; py++) {
      const rowA = j0[py] * nx;
      const rowB = j1[py] * nx;
      const ty = fy[py];
      const sy = 1 - ty;
      for (let px = 0; px < w; px++, p++) {
        const a = rowA + i0[px];
        const b = rowA + i1[px];
        const c = rowB + i0[px];
        const d = rowB + i1[px];
        const tx = fx[px];
        let wa = (1 - tx) * sy;
        let wb = tx * sy;
        let wc = (1 - tx) * ty;
        let wd = tx * ty;

        const anySolid = solid[a] | solid[b] | solid[c] | solid[d];
        if (anySolid !== 0) {
          const cover = wa * solid[a] + wb * solid[b] + wc * solid[c] + wd * solid[d];
          if (cover >= 0.5) {
            if (showPaint) {
              const paint = Math.min(1, wa * flowVis[a] + wb * flowVis[b] + wc * flowVis[c] + wd * flowVis[d]);
              if (paint > 0.004) {
                // Gamma < 1 so thin films are already visible.
                const k = Math.sqrt(paint);
                pixels[p] = packRgb((sr + (pr - sr) * k) | 0, (sg + (pg - sg) * k) | 0, (sb + (pb - sb) * k) | 0);
                continue;
              }
            }
            pixels[p] = solidColor;
            continue;
          }
          if (mode !== 1) {
            // Wall-adjacent fluid: renormalise over fluid cells only.
            wa *= 1 - solid[a];
            wb *= 1 - solid[b];
            wc *= 1 - solid[c];
            wd *= 1 - solid[d];
            const inv = 1 / (wa + wb + wc + wd);
            wa *= inv;
            wb *= inv;
            wc *= inv;
            wd *= inv;
          }
        }

        if (mode === 0) {
          const cp = (wa * rho[a] + wb * rho[b] + wc * rho[c] + wd * rho[d] - rhoRef) * cpScale;
          let t = 127.5 + (cp < 0 ? cp * cpNeg : cp * cpPos);
          t = t < 0 ? 0 : t > 255 ? 255 : t;
          pixels[p] = pressureLut[t | 0];
        } else if (mode === 1) {
          const vx = wa * ux[a] + wb * ux[b] + wc * ux[c] + wd * ux[d];
          const vy = wa * uy[a] + wb * uy[b] + wc * uy[c] + wd * uy[d];
          let t = Math.sqrt(vx * vx + vy * vy) * velScale;
          t = t > 255 ? 255 : t;
          pixels[p] = velocityLut[t | 0];
        } else if (mode === 2) {
          const wz = (wa * curl[a] + wb * curl[b] + wc * curl[c] + wd * curl[d]) * curlScale;
          // Signed square-root compression: weak shear layers stay readable.
          const s = wz < 0 ? -Math.sqrt(-wz) : Math.sqrt(wz);
          let t = 127.5 + 127.5 * s;
          t = t < 0 ? 0 : t > 255 ? 255 : t;
          pixels[p] = vorticityLut[t | 0];
        } else {
          const a3 = a * 3;
          const b3 = b * 3;
          const c3 = c * 3;
          const d3 = d * 3;
          const r = wa * smoke[a3] + wb * smoke[b3] + wc * smoke[c3] + wd * smoke[d3];
          const g = wa * smoke[a3 + 1] + wb * smoke[b3 + 1] + wc * smoke[c3 + 1] + wd * smoke[d3 + 1];
          const bl = wa * smoke[a3 + 2] + wb * smoke[b3 + 2] + wc * smoke[c3 + 2] + wd * smoke[d3 + 2];
          // Faint speed shading gives the dark tunnel some depth behind the dye.
          const vx = wa * ux[a] + wb * ux[b] + wc * ux[c] + wd * ux[d];
          const vy = wa * uy[a] + wb * uy[b] + wc * uy[c] + wd * uy[d];
          const depth = Math.min(1.8, Math.sqrt(vx * vx + vy * vy) / uRef) * 9;
          let R = br + depth * 0.7 + r * 255;
          let G = bg + depth * 0.85 + g * 255;
          let B = bb + depth + bl * 255;
          R = R > 255 ? 255 : R;
          G = G > 255 ? 255 : G;
          B = B > 255 ? 255 : B;
          pixels[p] = packRgb(R | 0, G | 0, B | 0);
        }
      }
    }

    this.ctx.putImageData(image, 0, 0);
    return this.canvas;
  }
}

/** Bilinear sample of a cell-centred field at fractional grid coordinates. */
export function sampleField(field: Float32Array, nx: number, ny: number, x: number, y: number): number {
  const gx = Math.min(nx - 1, Math.max(0, x));
  const gy = Math.min(ny - 1, Math.max(0, y));
  const i = Math.min(nx - 2, Math.floor(gx));
  const j = Math.min(ny - 2, Math.floor(gy));
  const tx = gx - i;
  const ty = gy - j;
  const a = i + j * nx;
  return (field[a] * (1 - tx) + field[a + 1] * tx) * (1 - ty) + (field[a + nx] * (1 - tx) + field[a + nx + 1] * tx) * ty;
}
