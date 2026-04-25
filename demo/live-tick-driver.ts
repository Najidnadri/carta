import {
  type OhlcRecord,
  type TimeSeriesChart,
} from "../src/index.js";
import { type MockSource } from "./mock-source.js";

export interface LiveTickDriverOptions {
  readonly chart: TimeSeriesChart;
  readonly source: MockSource;
  readonly ohlcChannel: string;
  readonly volumeChannel: string;
  readonly intervalMs?: number;
  readonly clock?: () => number;
  readonly onTick?: () => void;
  readonly setTimer?: (cb: () => void, delay: number) => number;
  readonly clearTimer?: (id: number) => void;
}

/**
 * Self-rescheduling 1 Hz live-tick emitter. Drift-free: each wake-up
 * recomputes against an absolute schedule (`nextWake = previousWake +
 * cadence`) so a long throttle does not accumulate. On `start()` the
 * loop schedules its first wake-up `cadence` ms in the future.
 *
 * Caller owns lifecycle: must `stop()` before `chart.destroy()` and
 * before `chart.setInterval()` (because the latter wipes the
 * prev-interval cache, and a tick mid-flip would write to the
 * about-to-be-discarded bucket).
 */
export class LiveTickDriver {
  private readonly chart: TimeSeriesChart;
  private readonly source: MockSource;
  private readonly ohlcChannel: string;
  private readonly volumeChannel: string;
  private readonly cadence: number;
  private readonly clock: () => number;
  private readonly onTick: () => void;
  private readonly setTimer: (cb: () => void, delay: number) => number;
  private readonly clearTimer: (id: number) => void;
  private timerId: number | null = null;
  private nextWake = 0;
  private running = false;
  private tickCount = 0;

  constructor(opts: LiveTickDriverOptions) {
    this.chart = opts.chart;
    this.source = opts.source;
    this.ohlcChannel = opts.ohlcChannel;
    this.volumeChannel = opts.volumeChannel;
    this.cadence = Math.max(50, opts.intervalMs ?? 1000);
    this.clock = opts.clock ?? ((): number => performance.now());
    this.onTick = opts.onTick ?? ((): void => undefined);
    this.setTimer =
      opts.setTimer ??
      ((cb: () => void, delay: number): number =>
        globalThis.setTimeout(cb, delay) as unknown as number);
    this.clearTimer =
      opts.clearTimer ??
      ((id: number): void => {
        globalThis.clearTimeout(id);
      });
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.nextWake = this.clock() + this.cadence;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      this.clearTimer(this.timerId);
      this.timerId = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  tickCounter(): number {
    return this.tickCount;
  }

  /** Force-fire one tick (for tests). Does nothing if not running. */
  fireOnceForTest(): void {
    if (this.running) {
      this.fire();
    }
  }

  private schedule(): void {
    if (!this.running) {
      return;
    }
    const drift = Math.max(0, this.nextWake - this.clock());
    this.timerId = this.setTimer(() => {
      this.timerId = null;
      if (!this.running) {
        return;
      }
      this.fire();
      this.nextWake += this.cadence;
      this.schedule();
    }, drift);
  }

  private fire(): void {
    const iv = Number(this.chart.getInterval());
    if (!Number.isFinite(iv) || iv <= 0) {
      return;
    }
    const now = Date.now();
    const records = this.chart.recordsInRange(
      this.ohlcChannel,
      iv,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    let prev: OhlcRecord | null = null;
    if (records.length > 0) {
      const last = records[records.length - 1];
      if (last !== undefined && "open" in last) {
        prev = last;
      }
    }
    const nextOhlc = this.source.tickOhlc(iv, now, prev);
    this.chart.supplyTick(this.ohlcChannel, nextOhlc, iv);
    const nextVolume = this.source.tickVolume(iv, now, nextOhlc);
    this.chart.supplyTick(this.volumeChannel, nextVolume, iv);
    this.tickCount++;
    this.onTick();
  }
}
