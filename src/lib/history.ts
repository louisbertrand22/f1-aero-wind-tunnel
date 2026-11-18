/** One telemetry sample of the rolling history. */
export interface HistorySample {
  /** Wall-clock seconds since the session started. */
  t: number;
  downforceN: number;
  dragN: number;
  ld: number;
}

export type HistoryChannel = 'downforceN' | 'dragN' | 'ld';

/**
 * Fixed-capacity ring buffer feeding the rolling telemetry chart. Lives
 * outside React state: the chart reads it from its own animation frame, so
 * 30 Hz sampling never triggers a re-render.
 */
export class HistoryBuffer {
  readonly capacity: number;
  private readonly t: Float64Array;
  private readonly df: Float32Array;
  private readonly drag: Float32Array;
  private readonly ld: Float32Array;
  private head = 0;
  private count = 0;
  /** Incremented on every mutation — cheap change detection for the chart. */
  version = 0;

  constructor(capacity = 900) {
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.df = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.ld = new Float32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(sample: HistorySample): void {
    const i = this.head;
    this.t[i] = sample.t;
    this.df[i] = sample.downforceN;
    this.drag[i] = sample.dragN;
    this.ld[i] = sample.ld;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.version++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.version++;
  }

  /** Physical slot of the k-th sample, k = 0 being the oldest. */
  private slot(k: number): number {
    return (this.head - this.count + k + this.capacity * 2) % this.capacity;
  }

  /** Time of the k-th sample (0 = oldest). */
  timeAt(k: number): number {
    return this.t[this.slot(k)];
  }

  /** Value of a channel for the k-th sample (0 = oldest). */
  valueAt(channel: HistoryChannel, k: number): number {
    const s = this.slot(k);
    return channel === 'downforceN' ? this.df[s] : channel === 'dragN' ? this.drag[s] : this.ld[s];
  }

  get(k: number): HistorySample {
    const s = this.slot(k);
    return { t: this.t[s], downforceN: this.df[s], dragN: this.drag[s], ld: this.ld[s] };
  }

  latest(): HistorySample | null {
    return this.count > 0 ? this.get(this.count - 1) : null;
  }

  /** Mean of the samples newer than `now − windowS`; null when empty. */
  mean(windowS: number): HistorySample | null {
    if (this.count === 0) return null;
    const tEnd = this.timeAt(this.count - 1);
    let n = 0;
    let df = 0;
    let drag = 0;
    for (let k = this.count - 1; k >= 0; k--) {
      const s = this.slot(k);
      if (tEnd - this.t[s] > windowS) break;
      df += this.df[s];
      drag += this.drag[s];
      n++;
    }
    if (n === 0) return null;
    df /= n;
    drag /= n;
    return { t: tEnd, downforceN: df, dragN: drag, ld: Math.abs(drag) > 1e-9 ? df / drag : 0 };
  }
}
