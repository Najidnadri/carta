import {
  asPixel,
  asTime,
  type Interval,
  type Pixel,
  type Time,
} from "../types.js";

export interface TimeScaleInput {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
  readonly pixelWidth: number;
}

export function alignDown(t: number, interval: number): number {
  return Math.floor(t / interval) * interval;
}

/**
 * Pure projection from `(startTime, endTime, intervalDuration, pixelWidth)`
 * to bar slots + pixels.
 *
 * `visibleBarSlots()` is inclusive-inclusive: it returns every slot timestamp
 * in `[alignDown(startTime), alignDown(endTime)]` stepping by
 * `intervalDuration`. When the input is degenerate (non-finite, non-positive
 * interval, or `startTime > endTime`) the scale collapses to zero slots and
 * reports `valid === false`.
 */
export class TimeScale {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
  readonly pixelWidth: number;
  readonly valid: boolean;
  readonly barSpacingPx: number;
  readonly slotCount: number;
  readonly firstSlotMs: number;

  private readonly spanMs: number;

  constructor(input: TimeScaleInput) {
    this.startTime = input.startTime;
    this.endTime = input.endTime;
    this.intervalDuration = input.intervalDuration;
    this.pixelWidth = input.pixelWidth;

    const start = input.startTime;
    const end = input.endTime;
    const interval = input.intervalDuration;
    const width = input.pixelWidth;

    const validInputs =
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Number.isFinite(interval) &&
      Number.isFinite(width) &&
      interval > 0 &&
      width >= 0 &&
      start <= end;

    this.valid = validInputs;
    if (!validInputs) {
      this.spanMs = 0;
      this.firstSlotMs = 0;
      this.barSpacingPx = 0;
      this.slotCount = 0;
      return;
    }

    this.spanMs = end - start;
    this.firstSlotMs = alignDown(start, interval);
    const lastSlot = alignDown(end, interval);
    this.slotCount = Math.floor((lastSlot - this.firstSlotMs) / interval) + 1;
    this.barSpacingPx = this.spanMs === 0 ? 0 : (width * interval) / this.spanMs;
  }

  timeToPixel(t: Time): Pixel {
    if (!this.valid || this.spanMs === 0) {
      return asPixel(0);
    }
    const raw = ((Number(t) - Number(this.startTime)) / this.spanMs) * this.pixelWidth;
    return asPixel(raw);
  }

  pixelToTime(p: Pixel): Time {
    if (!this.valid || this.pixelWidth === 0) {
      return this.startTime;
    }
    const raw = Number(this.startTime) + (Number(p) / this.pixelWidth) * this.spanMs;
    return asTime(raw);
  }

  barIndexAtTime(t: Time): number {
    if (!this.valid) {
      return 0;
    }
    return Math.round((Number(t) - this.firstSlotMs) / Number(this.intervalDuration));
  }

  timeOfBarIndex(i: number): Time {
    if (!this.valid) {
      return this.startTime;
    }
    return asTime(this.firstSlotMs + i * Number(this.intervalDuration));
  }

  /**
   * Snap a plot-local pixel X to the `Time` of the bar centre under it.
   * Returns `null` when the scale is invalid, has no slots, or when
   * `pixelX` is outside `[0, plotWidth]`. Rounds to the nearest slot via
   * `barIndexAtTime`, then clamps to `[0, slotCount - 1]`.
   */
  snapToBarTime(pixelX: Pixel | number, plotWidth: number): Time | null {
    if (!this.valid || this.slotCount <= 0) {
      return null;
    }
    if (!Number.isFinite(plotWidth) || plotWidth <= 0) {
      return null;
    }
    const x = Number(pixelX);
    if (!Number.isFinite(x) || x < 0 || x > plotWidth) {
      return null;
    }
    const t = this.pixelToTime(asPixel(x));
    const idx = this.barIndexAtTime(t);
    const clamped = Math.max(0, Math.min(this.slotCount - 1, idx));
    return this.timeOfBarIndex(clamped);
  }

  /**
   * Companion to `snapToBarTime` — returns both the snapped `Time` and the
   * centre pixel-X of that bar. Saves a round-trip through `timeToPixel`
   * when a caller needs both (e.g. the crosshair controller).
   */
  snapToBarPixel(pixelX: Pixel | number, plotWidth: number): { time: Time; x: Pixel } | null {
    const time = this.snapToBarTime(pixelX, plotWidth);
    if (time === null) {
      return null;
    }
    return { time, x: this.timeToPixel(time) };
  }

  visibleBarSlots(): readonly Time[] {
    if (!this.valid || this.slotCount <= 0) {
      return [];
    }
    const slots: Time[] = [];
    const interval = Number(this.intervalDuration);
    for (let i = 0; i < this.slotCount; i++) {
      slots.push(asTime(this.firstSlotMs + i * interval));
    }
    return slots;
  }
}
