/**
 * 3×3 binomial smoothing of a cell-centred scalar, restricted to fluid cells.
 *
 * BGK at low viscosity carries a grid-scale "checkerboard" mode in the
 * density. It is harmless for the momentum balance but shows up as a moiré in
 * the Cp map, where a density ripple of 1e-4 is already visible because the
 * dynamic pressure is tiny in lattice units. The [1 2 1]⊗[1 2 1] kernel has a
 * zero at the Nyquist frequency: it removes exactly that mode and leaves the
 * resolved pressure field untouched. Solid neighbours are excluded so the
 * surface pressure is not polluted by values stored inside the body.
 */
export function smoothFluidScalar(src: Float32Array, solid: Uint8Array, nx: number, ny: number, out: Float32Array): void {
  out.set(src);
  for (let j = 1; j < ny - 1; j++) {
    const row = j * nx;
    for (let i = 1; i < nx - 1; i++) {
      const c = row + i;
      if (solid[c] !== 0) continue;
      const n = c - nx;
      const s = c + nx;
      // Fast path: no wall in the stencil.
      if ((solid[n - 1] | solid[n] | solid[n + 1] | solid[c - 1] | solid[c + 1] | solid[s - 1] | solid[s] | solid[s + 1]) === 0) {
        out[c] = (4 * src[c] + 2 * (src[n] + src[s] + src[c - 1] + src[c + 1]) + src[n - 1] + src[n + 1] + src[s - 1] + src[s + 1]) * 0.0625;
        continue;
      }
      let sum = 4 * src[c];
      let w = 4;
      if (solid[n] === 0) {
        sum += 2 * src[n];
        w += 2;
      }
      if (solid[s] === 0) {
        sum += 2 * src[s];
        w += 2;
      }
      if (solid[c - 1] === 0) {
        sum += 2 * src[c - 1];
        w += 2;
      }
      if (solid[c + 1] === 0) {
        sum += 2 * src[c + 1];
        w += 2;
      }
      if (solid[n - 1] === 0) {
        sum += src[n - 1];
        w += 1;
      }
      if (solid[n + 1] === 0) {
        sum += src[n + 1];
        w += 1;
      }
      if (solid[s - 1] === 0) {
        sum += src[s - 1];
        w += 1;
      }
      if (solid[s + 1] === 0) {
        sum += src[s + 1];
        w += 1;
      }
      out[c] = sum / w;
    }
  }
}
