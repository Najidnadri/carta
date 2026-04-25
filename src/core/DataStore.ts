import { IntervalCache } from "./IntervalCache.js";
import { noopLogger } from "./Logger.js";
import type {
  CacheStats,
  Channel,
  ChannelKind,
  ClearCacheOptions,
  DataOptions,
  DataRecord,
  Logger,
  MarkerRecord,
  OhlcRecord,
  PointRecord,
  Range,
} from "../types.js";

const DEFAULT_CAPS = {
  ohlc: 500_000,
  point: 500_000,
  marker: 50_000,
} as const;

const DEFAULT_SLACK = 1_000;
const DEFAULT_THRESHOLD_BARS = 1;

interface ResolvedDataOptions {
  readonly caps: { readonly ohlc: number; readonly point: number; readonly marker: number };
  readonly requestThresholdBars: number;
}

function resolveOptions(options: DataOptions | undefined): ResolvedDataOptions {
  const caps = options?.caps;
  return {
    caps: {
      ohlc: caps?.ohlc ?? DEFAULT_CAPS.ohlc,
      point: caps?.point ?? DEFAULT_CAPS.point,
      marker: caps?.marker ?? DEFAULT_CAPS.marker,
    },
    requestThresholdBars: options?.requestThresholdBars ?? DEFAULT_THRESHOLD_BARS,
  };
}

export function isOhlcRecord(r: DataRecord): r is OhlcRecord {
  return (
    "open" in r &&
    "high" in r &&
    "low" in r &&
    "close" in r &&
    typeof r.open === "number" &&
    typeof r.high === "number" &&
    typeof r.low === "number" &&
    typeof r.close === "number"
  );
}

export function isPointRecord(r: DataRecord): r is PointRecord {
  return "value" in r && typeof r.value === "number";
}

export function isMarkerRecord(r: DataRecord): r is MarkerRecord {
  return (
    "position" in r &&
    "shape" in r &&
    typeof r.position === "string" &&
    typeof r.shape === "string"
  );
}

function recordMatchesKind(r: DataRecord, kind: ChannelKind): boolean {
  switch (kind) {
    case "ohlc":
      return isOhlcRecord(r);
    case "point":
      return isPointRecord(r);
    case "marker":
      return isMarkerRecord(r);
    default:
      return false;
  }
}

interface ChannelStoreInternal {
  readonly channel: Channel;
  readonly byInterval: Map<number, IntervalCache<DataRecord>>;
}

/**
 * Single-symbol, multi-channel, interval-partitioned data store.
 *
 * Public surface keys on `channelId: string` per miniplan §3.7; kind safety is
 * enforced at runtime — mismatched records are dropped with `logger.warn`.
 *
 * See `plans/05-data-cache.md` for the full semantics.
 */
export class DataStore {
  private readonly channels = new Map<string, ChannelStoreInternal>();
  private readonly logger: Logger;
  private readonly opts: ResolvedDataOptions;

  constructor(opts?: { logger?: Logger; options?: DataOptions }) {
    this.logger = opts?.logger ?? noopLogger;
    this.opts = resolveOptions(opts?.options);
  }

  get requestThresholdBars(): number {
    return this.opts.requestThresholdBars;
  }

  /**
   * Register a channel. Idempotent when re-called with the same `kind`;
   * throws synchronously on kind collision.
   */
  defineChannel(channel: Channel): void {
    const existing = this.channels.get(channel.id);
    if (existing !== undefined) {
      if (existing.channel.kind !== channel.kind) {
        throw new Error(
          `[carta] channel '${channel.id}' already registered with kind '${existing.channel.kind}'; ` +
            `cannot redefine as '${channel.kind}'`,
        );
      }
      return;
    }
    this.channels.set(channel.id, {
      channel: Object.freeze({ id: channel.id, kind: channel.kind }),
      byInterval: new Map(),
    });
  }

  hasChannel(id: string): boolean {
    return this.channels.has(id);
  }

  getChannel(id: string): Channel | undefined {
    return this.channels.get(id)?.channel;
  }

  insert(channelId: string, intervalDuration: number, record: DataRecord): boolean {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      throw new Error(
        `[carta] insert on unregistered channel '${channelId}'. Call chart.defineChannel() first.`,
      );
    }
    if (!recordMatchesKind(record, store.channel.kind)) {
      this.logger.warn(
        `[carta] dropping record with kind mismatch on channel '${channelId}' (expected ${store.channel.kind})`,
        { record },
      );
      return false;
    }
    return this.cacheFor(store, intervalDuration).insert(record);
  }

  insertMany(
    channelId: string,
    intervalDuration: number,
    records: readonly DataRecord[],
  ): number {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      throw new Error(
        `[carta] insertMany on unregistered channel '${channelId}'. Call chart.defineChannel() first.`,
      );
    }
    if (records.length === 0) {
      return 0;
    }
    const matching: DataRecord[] = [];
    let dropped = 0;
    for (const r of records) {
      if (recordMatchesKind(r, store.channel.kind)) {
        matching.push(r);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      this.logger.warn(
        `[carta] dropped ${String(dropped)} records with kind mismatch on channel '${channelId}' (expected ${store.channel.kind})`,
      );
    }
    if (matching.length === 0) {
      return 0;
    }
    return this.cacheFor(store, intervalDuration).insertMany(matching);
  }

  getAt(
    channelId: string,
    intervalDuration: number,
    time: number,
  ): DataRecord | undefined {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      return undefined;
    }
    const cache = store.byInterval.get(intervalDuration);
    if (cache === undefined) {
      return undefined;
    }
    return cache.getAt(time);
  }

  /**
   * Alias for `getAt` scoped to the crosshair use-case: "what record sits at
   * this exact snapped bar time?" Kept as its own method so callers reading
   * `chart.dataStore.getBar(...)` read intent-first.
   */
  getBar(
    channelId: string,
    intervalDuration: number,
    time: number,
  ): DataRecord | undefined {
    return this.getAt(channelId, intervalDuration, time);
  }

  /**
   * O(log n). Earliest record time in `[start, end]` for the channel's cache
   * at this interval, or `null` when nothing qualifies (channel unregistered,
   * no cache bucket, empty, or no record inside the range).
   */
  earliestTimeInWindow(
    channelId: string,
    intervalDuration: number,
    start: number,
    end: number,
  ): number | null {
    const cache = this.channels.get(channelId)?.byInterval.get(intervalDuration);
    return cache?.firstTimeInRange(start, end) ?? null;
  }

  /**
   * O(log n). Latest record time in `[start, end]` for the channel's cache
   * at this interval. See `earliestTimeInWindow` for null semantics.
   */
  latestTimeInWindow(
    channelId: string,
    intervalDuration: number,
    start: number,
    end: number,
  ): number | null {
    const cache = this.channels.get(channelId)?.byInterval.get(intervalDuration);
    return cache?.lastTimeInRange(start, end) ?? null;
  }

  recordsInRange(
    channelId: string,
    intervalDuration: number,
    start: number,
    end: number,
  ): readonly DataRecord[] {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      return [];
    }
    const cache = store.byInterval.get(intervalDuration);
    if (cache === undefined) {
      return [];
    }
    return cache.recordsInRange(start, end);
  }

  missingRanges(
    channelId: string,
    intervalDuration: number,
    start: number,
    end: number,
  ): readonly Range[] {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      return [];
    }
    if (store.channel.kind === "marker") {
      return [];
    }
    const cache = store.byInterval.get(intervalDuration);
    if (cache === undefined) {
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        !Number.isFinite(intervalDuration) ||
        intervalDuration <= 0 ||
        !Number.isInteger(intervalDuration)
      ) {
        return [];
      }
      const s = Math.floor(start / intervalDuration) * intervalDuration;
      const e = Math.floor(end / intervalDuration) * intervalDuration;
      if (s > e) {
        return [];
      }
      return [{ start: s, end: e }];
    }
    return cache.missingRanges(start, end, this.opts.requestThresholdBars);
  }

  size(channelId: string, intervalDuration: number): number {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      return 0;
    }
    return store.byInterval.get(intervalDuration)?.size() ?? 0;
  }

  /**
   * Per-channel snapshot of intervals loaded and total record counts.
   * Channels with no buckets yet (`defineChannel`-only) are still listed
   * with `intervalsLoaded: []` and `totalRecords: 0`. Order matches
   * channel-registration order.
   */
  snapshot(): readonly CacheStats[] {
    const out: CacheStats[] = [];
    for (const store of this.channels.values()) {
      const intervals: number[] = [];
      let total = 0;
      for (const [iv, cache] of store.byInterval) {
        intervals.push(iv);
        total += cache.size();
      }
      intervals.sort((a, b) => a - b);
      out.push({
        channelId: store.channel.id,
        kind: store.channel.kind,
        intervalsLoaded: intervals,
        totalRecords: total,
      });
    }
    return out;
  }

  revision(channelId: string, intervalDuration: number): number {
    const store = this.channels.get(channelId);
    if (store === undefined) {
      return 0;
    }
    return store.byInterval.get(intervalDuration)?.revision ?? 0;
  }

  /**
   * Wipe the `prevIv` bucket across every channel. No-op when `newIv === prevIv`
   * or `prevIv` is null.
   */
  setInterval(newIv: number, prevIv: number | null): void {
    if (prevIv === null || prevIv === newIv) {
      return;
    }
    for (const store of this.channels.values()) {
      const cache = store.byInterval.get(prevIv);
      if (cache !== undefined) {
        cache.clear();
        store.byInterval.delete(prevIv);
      }
    }
  }

  clearCache(opts?: ClearCacheOptions): void {
    const channelId = opts?.channelId;
    const intervalDuration = opts?.intervalDuration;
    if (channelId === undefined && intervalDuration === undefined) {
      this.clearAll();
      return;
    }
    if (channelId !== undefined && intervalDuration !== undefined) {
      const store = this.channels.get(channelId);
      if (store === undefined) {
        return;
      }
      const cache = store.byInterval.get(intervalDuration);
      if (cache !== undefined) {
        cache.clear();
        store.byInterval.delete(intervalDuration);
      }
      return;
    }
    if (channelId !== undefined) {
      this.clearChannel(channelId);
      return;
    }
    if (intervalDuration === undefined) {
      return;
    }
    for (const store of this.channels.values()) {
      const cache = store.byInterval.get(intervalDuration);
      if (cache !== undefined) {
        cache.clear();
        store.byInterval.delete(intervalDuration);
      }
    }
  }

  clearChannel(id: string): void {
    const store = this.channels.get(id);
    if (store === undefined) {
      return;
    }
    for (const cache of store.byInterval.values()) {
      cache.clear();
    }
    store.byInterval.clear();
  }

  clearAll(): void {
    for (const store of this.channels.values()) {
      for (const cache of store.byInterval.values()) {
        cache.clear();
      }
      store.byInterval.clear();
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private cacheFor(
    store: ChannelStoreInternal,
    intervalDuration: number,
  ): IntervalCache<DataRecord> {
    const existing = store.byInterval.get(intervalDuration);
    if (existing !== undefined) {
      return existing;
    }
    const capFor = this.opts.caps[store.channel.kind];
    const cache = new IntervalCache<DataRecord>({
      interval: intervalDuration,
      kind: store.channel.kind,
      options: { cap: capFor, slack: DEFAULT_SLACK },
      logger: this.logger,
    });
    store.byInterval.set(intervalDuration, cache);
    return cache;
  }
}
