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

    const start = Number(input.startTime);
    const end = Number(input.endTime);
    const interval = Number(input.intervalDuration);
    const width = Number(input.pixelWidth);

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
