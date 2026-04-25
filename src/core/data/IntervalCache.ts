import { alignDown } from "../time/TimeScale.js";
import { isAscending, lowerBound } from "./sortedArray.js";
import type { ChannelKind, DataRecord, Logger, Range } from "../../types.js";

export interface IntervalCacheOptions {
  readonly cap: number;
  readonly slack: number;
}

const ALIGNMENT_SAMPLE_STRIDE = 16;

/**
 * Interval-scoped cache for a single channel at a single `intervalDuration`.
 *
 * Internal structure: sorted `number[]` of times in ascending order, plus a
 * `Map<number, R>` for O(1) point lookup. Both stay in lockstep.
 *
 * - Single-record insert is O(log n) search + O(n) splice (mid-array) or O(1)
 *   append (right edge — hot path for live ticks).
 * - Bulk `insertMany` is O(existing + incoming) via two-pointer merge.
 * - `recordsInRange` is O(log n + k).
 * - `missingRanges` is O(cached points in window), never materializing the
 *   expected-slot set.
 *
 * `revision` is a monotonic counter bumped on any mutation. Phase-07 series
 * can memoize on it without a store-API break.
 *
 * Alignment is enforced for `ohlc` / `point` kinds (records whose
 * `time % interval !== 0` are dropped with a `logger.warn`). Markers skip the
 * check — the renderer snaps them to the nearest slot.
 */
export class IntervalCache<R extends DataRecord> {
  readonly interval: number;
  readonly kind: ChannelKind;
  readonly cap: number;
  readonly slack: number;

  private readonly logger: Logger;
  private _times: number[] = [];
  private _byTime = new Map<number, R>();
  private _revision = 0;

  constructor(params: {
    interval: number;
    kind: ChannelKind;
    options: IntervalCacheOptions;
    logger: Logger;
  }) {
    this.interval = params.interval;
    this.kind = params.kind;
    this.cap = params.options.cap;
    this.slack = params.options.slack;
    this.logger = params.logger;
  }

  get revision(): number {
    return this._revision;
  }

  size(): number {
    return this._times.length;
  }

  getAt(time: number): R | undefined {
    return this._byTime.get(time);
  }

  /** O(1). Returns the earliest cached record time, or `null` if empty. */
  firstTime(): number | null {
    return this._times.length === 0 ? null : (this._times[0] as number);
  }

  /** O(1). Returns the latest cached record time, or `null` if empty. */
  lastTime(): number | null {
    const n = this._times.length;
    return n === 0 ? null : (this._times[n - 1] as number);
  }

  /**
   * Insert a single record. Returns `true` if the record was accepted,
   * `false` if it was dropped (non-finite time, or unaligned on ohlc/point).
   */
  insert(record: R): boolean {
    if (!this.isInsertable(record)) {
      return false;
    }
    const t = Number(record.time);
    this.insertInternal(t, record);
    this.maybeEvict();
    this._revision++;
    return true;
  }

  /**
   * Bulk insert. Uses a two-pointer merge when incoming is pre-sorted;
   * falls back to individual inserts if not.
   */
  insertMany(records: readonly R[]): number {
    if (records.length === 0) {
      return 0;
    }

    const accepted: R[] = this.filterInsertable(records);
    if (accepted.length === 0) {
      return 0;
    }

    const incomingTimes: number[] = accepted.map((r) => Number(r.time));
    let sortedIncoming: { times: number[]; records: R[] };
    if (isAscending(incomingTimes)) {
      sortedIncoming = { times: incomingTimes, records: accepted };
    } else {
      const indices = accepted.map((_, i) => i);
      indices.sort((a, b) => (incomingTimes[a] as number) - (incomingTimes[b] as number));
      sortedIncoming = {
        times: indices.map((i) => incomingTimes[i] as number),
        records: indices.map((i) => accepted[i] as R),
      };
    }

    const acceptedCount = this.mergeInsert(sortedIncoming.times, sortedIncoming.records);
    if (acceptedCount > 0) {
      this.maybeEvict();
      this._revision++;
    }
    return acceptedCount;
  }

  /**
   * O(log n). Earliest cached record time with `start <= time <= end`, or
   * `null` if no cached record falls in the inclusive range.
   */
  firstTimeInRange(start: number, end: number): number | null {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      this._times.length === 0
    ) {
      return null;
    }
    const idx = lowerBound(this._times, start);
    if (idx >= this._times.length) {
      return null;
    }
    const t = this._times[idx] as number;
    return t > end ? null : t;
  }

  /**
   * O(log n). Latest cached record time with `start <= time <= end`, or
   * `null` if no cached record falls in the inclusive range.
   */
  lastTimeInRange(start: number, end: number): number | null {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      this._times.length === 0
    ) {
      return null;
    }
    const hi = lowerBound(this._times, end + 1);
    if (hi === 0) {
      return null;
    }
    const t = this._times[hi - 1] as number;
    return t < start ? null : t;
  }

  /**
   * Inclusive-inclusive range slice: records with `start <= time <= end`.
   * Returns a fresh array — the host may mutate it.
   */
  recordsInRange(start: number, end: number): readonly R[] {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      this._times.length === 0
    ) {
      return [];
    }
    const lo = lowerBound(this._times, start);
    const hi = lowerBound(this._times, end + 1);
    if (lo >= hi) {
      return [];
    }
    const out = new Array<R>(hi - lo);
    for (let i = lo; i < hi; i++) {
      out[i - lo] = this._byTime.get(this._times[i] as number) as R;
    }
    return out;
  }

  /**
   * Gap-scan over cached times. For marker kinds, short-circuits to `[]`.
   *
   * `thresholdBars` is the minimum contiguous gap size (in slots) that
   * triggers a range emission. Default 1 → every missing slot emits.
   */
  missingRanges(start: number, end: number, thresholdBars: number): readonly Range[] {
    if (this.kind === "marker") {
      return [];
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(this.interval) ||
      this.interval <= 0 ||
      !Number.isInteger(this.interval)
    ) {
      return [];
    }
    const s = alignDown(start, this.interval);
    const e = alignDown(end, this.interval);
    if (s > e) {
      return [];
    }

    const out: Range[] = [];
    const lo = lowerBound(this._times, s);
    const hi = lowerBound(this._times, e + 1);

    let cursor = s;
    for (let k = lo; k < hi; k++) {
      const t = this._times[k] as number;
      const missingCount = (t - cursor) / this.interval;
      if (missingCount >= thresholdBars && missingCount > 0) {
        out.push({ start: cursor, end: t - this.interval });
      }
      cursor = t + this.interval;
    }
    if (cursor <= e) {
      const missingCount = (e - cursor) / this.interval + 1;
      if (missingCount >= thresholdBars) {
        out.push({ start: cursor, end: e });
      }
    }
    return out;
  }

  clear(): void {
    if (this._times.length === 0 && this._byTime.size === 0) {
      return;
    }
    this._times = [];
    this._byTime = new Map();
    this._revision++;
  }

  /** Remove the `count` oldest records. Caller must ensure count > 0. */
  evictOldest(count: number): void {
    const clamped = Math.min(count, this._times.length);
    if (clamped <= 0) {
      return;
    }
    const removed = this._times.splice(0, clamped);
    for (const t of removed) {
      this._byTime.delete(t);
    }
    this._revision++;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private isInsertable(record: R): boolean {
    const t = Number(record.time);
    if (!Number.isFinite(t)) {
      this.logger.warn("[carta] dropping record with non-finite time", {
        kind: this.kind,
        time: record.time,
      });
      return false;
    }
    if (this.kind === "marker") {
      return true;
    }
    if (!Number.isFinite(this.interval) || this.interval <= 0) {
      return false;
    }
    if (t % this.interval !== 0) {
      this.logger.warn("[carta] dropping unaligned record", {
        kind: this.kind,
        time: t,
        interval: this.interval,
      });
      return false;
    }
    return true;
  }

  private filterInsertable(records: readonly R[]): R[] {
    if (this.kind === "marker") {
      return records.filter((r) => {
        const t = Number(r.time);
        if (!Number.isFinite(t)) {
          this.logger.warn("[carta] dropping marker with non-finite time", { time: r.time });
          return false;
        }
        return true;
      });
    }

    if (!Number.isFinite(this.interval) || this.interval <= 0) {
      return [];
    }

    const sampled = this.sampledAligned(records);
    if (sampled) {
      return records.slice();
    }
    return records.filter((r) => this.isInsertable(r));
  }

  /** Fast path: verify first, last, and every 16th record is aligned. */
  private sampledAligned(records: readonly R[]): boolean {
    const n = records.length;
    if (n === 0) {
      return true;
    }
    const first = records[0] as R;
    const tFirst = Number(first.time);
    if (!Number.isFinite(tFirst) || tFirst % this.interval !== 0) {
      return false;
    }
    const last = records[n - 1] as R;
    const tLast = Number(last.time);
    if (!Number.isFinite(tLast) || tLast % this.interval !== 0) {
      return false;
    }
    for (let i = ALIGNMENT_SAMPLE_STRIDE; i < n; i += ALIGNMENT_SAMPLE_STRIDE) {
      const r = records[i] as R;
      const t = Number(r.time);
      if (!Number.isFinite(t) || t % this.interval !== 0) {
        return false;
      }
    }
    return true;
  }

  private insertInternal(time: number, record: R): void {
    if (this._byTime.has(time)) {
      this._byTime.set(time, record);
      return;
    }
    const n = this._times.length;
    if (n === 0 || time > (this._times[n - 1] as number)) {
      this._times.push(time);
    } else {
      const idx = lowerBound(this._times, time);
      this._times.splice(idx, 0, time);
    }
    this._byTime.set(time, record);
  }

  /**
   * Merge pre-sorted incoming arrays into the existing sorted state.
   * Dedups on time (last-write-wins) both against existing records and
   * within the incoming batch.
   */
  private mergeInsert(times: readonly number[], records: readonly R[]): number {
    const m = times.length;
    if (m === 0) {
      return 0;
    }
    const oldTimes = this._times;
    const n = oldTimes.length;

    const mergedTimes: number[] = [];
    mergedTimes.length = n + m;
    let idx = 0;
    let i = 0;
    let j = 0;

    while (i < n && j < m) {
      const ti = oldTimes[i] as number;
      const tj = times[j] as number;
      if (ti < tj) {
        mergedTimes[idx++] = ti;
        i++;
      } else if (tj < ti) {
        mergedTimes[idx++] = tj;
        this._byTime.set(tj, records[j] as R);
        j++;
      } else {
        mergedTimes[idx++] = tj;
        this._byTime.set(tj, records[j] as R);
        i++;
        j++;
      }
    }
    while (i < n) {
      mergedTimes[idx++] = oldTimes[i++] as number;
    }
    while (j < m) {
      const tj = times[j] as number;
      if (idx > 0 && (mergedTimes[idx - 1] as number) === tj) {
        this._byTime.set(tj, records[j] as R);
      } else {
        mergedTimes[idx++] = tj;
        this._byTime.set(tj, records[j] as R);
      }
      j++;
    }

    mergedTimes.length = idx;
    this._times = mergedTimes;
    return m;
  }

  private maybeEvict(): void {
    const over = this._times.length - this.cap;
    if (over <= 0) {
      return;
    }
    this.evictOldest(over + this.slack);
  }
}
