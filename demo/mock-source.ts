import {
  asPrice,
  asTime,
  type MarkerRecord,
  type OhlcRecord,
  type PointRecord,
} from "../src/index.js";

const MIN = 60_000;

export const VOLUME_UP_COLOR = 0x00e676;
export const VOLUME_DOWN_COLOR = 0xff1744;
const VOLUME_OVERLAY_BAND_FRACTION = 0.15;
const PIVOT_HALF_WINDOW = 2;
const SMA_DEFAULT_PERIOD = 20;

export interface MockSourceOptions {
  readonly basePrice?: number;
  readonly volatility?: number;
}

interface BaseBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Deterministic synthetic data source for the Carta demo. The fundamental
 * series is at 1-minute resolution; coarser intervals are aggregated as
 * `open=first.open, high=max(highs), low=min(lows), close=last.close,
 * volume=sum(volumes)`. The seed is a function of `(intervalDuration, time)`
 * only — no channelId — so SMA and volume stay correlated with the OHLC
 * stream they describe.
 */
export class MockSource {
  private readonly basePrice: number;
  private readonly volatility: number;
  private baseCache = new Map<number, BaseBar>();

  constructor(opts: MockSourceOptions = {}) {
    this.basePrice = opts.basePrice ?? 100;
    this.volatility = opts.volatility ?? 0.01;
  }

  /**
   * Synthesize a 1m bar at exactly `time` (must be aligned to MIN). The
   * recurrence is `prev.close → next.open` so a contiguous range is
   * deterministic but seeded from the absolute minute index — random access
   * `getBaseBar(t)` reproduces the same bar regardless of access order.
   */
  private getBaseBar(time: number): BaseBar {
    const cached = this.baseCache.get(time);
    if (cached !== undefined) {
      return cached;
    }
    const seed = mix32(0x9e3779b1, time / MIN);
    const rng = lcg(seed);
    const drift = (rng() - 0.5) * this.basePrice * this.volatility;
    // Open is anchored to a stable per-minute value so adjacent minutes drift
    // smoothly without us having to materialize the prefix recurrence.
    const open = this.basePrice + Math.sin(time / (MIN * 60)) * this.basePrice * 0.05;
    const close = Math.max(0.01, open + drift);
    const high = Math.max(open, close) + rng() * this.basePrice * 0.005;
    const low = Math.min(open, close) - rng() * this.basePrice * 0.005;
    // Phase 14 Cycle A — volatile volume profile. Combines: a slow sinusoidal
    // trend (so the histogram has shape), a high-frequency random component
    // (per-bar jitter), and pseudo-random burst spikes (~5 % of bars get
    // 3-8× the baseline). Produces an obviously irregular silhouette in the
    // dedicated volume pane.
    const trend = 1 + 0.6 * Math.sin(time / (MIN * 13));
    const jitter = 0.4 + rng() * 1.6; // 0.4–2.0
    const burstRoll = rng();
    const burstFactor = burstRoll > 0.95 ? 3 + rng() * 5 : 1;
    const volume = Math.max(50, Math.floor(800 * trend * jitter * burstFactor));
    const bar: BaseBar = {
      time,
      open,
      high,
      low: Math.max(0.0001, low),
      close,
      volume,
    };
    this.baseCache.set(time, bar);
    return bar;
  }

  private aggregate(intervalDuration: number, slot: number): BaseBar {
    if (intervalDuration === MIN) {
      return this.getBaseBar(slot);
    }
    const ratio = intervalDuration / MIN;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let volume = 0;
    let open = 0;
    let close = 0;
    for (let i = 0; i < ratio; i++) {
      const child = this.getBaseBar(slot + i * MIN);
      if (i === 0) {
        open = child.open;
      }
      if (child.high > high) {
        high = child.high;
      }
      if (child.low < low) {
        low = child.low;
      }
      volume += child.volume;
      close = child.close;
    }
    return { time: slot, open, high, low, close, volume };
  }

  /**
   * Determinstic OHLC bars in `[start, end]`, aligned to `intervalDuration`.
   * Same `(intervalDuration, start, end)` always returns identical records.
   */
  fetchOhlc(intervalDuration: number, start: number, end: number): OhlcRecord[] {
    if (!isValidIntervalRange(intervalDuration, start, end)) {
      return [];
    }
    const slotStart = Math.floor(start / intervalDuration) * intervalDuration;
    const slotEnd = Math.floor(end / intervalDuration) * intervalDuration;
    const out: OhlcRecord[] = [];
    for (let t = slotStart; t <= slotEnd; t += intervalDuration) {
      const bar = this.aggregate(intervalDuration, t);
      out.push({
        time: asTime(bar.time),
        open: asPrice(bar.open),
        high: asPrice(bar.high),
        low: asPrice(bar.low),
        close: asPrice(bar.close),
        volume: bar.volume,
      });
    }
    return out;
  }

  /**
   * Volume points scaled into the bottom 15% of the OHLC band so the
   * histogram overlays candles without dragging auto-scale outside the
   * candle extents. Color is derived per-record by `close ≥ open`.
   */
  fetchVolume(intervalDuration: number, start: number, end: number): PointRecord[] {
    const bars = this.fetchOhlc(intervalDuration, start, end);
    return scaleVolumeForOverlay(bars);
  }

  /**
   * Phase 14 Cycle A — raw volume points (un-scaled) for the dedicated-pane
   * recipe. Returns each bar's raw `volume` field as the histogram value,
   * with up/down color from the OHLC close vs open. The dedicated pane's
   * own `'right'` scale auto-scales these to fill the pane height.
   */
  fetchRawVolume(intervalDuration: number, start: number, end: number): PointRecord[] {
    const bars = this.fetchOhlc(intervalDuration, start, end);
    const out: PointRecord[] = [];
    for (const b of bars) {
      const v = b.volume ?? 0;
      const isUp = Number(b.close) >= Number(b.open);
      out.push({
        time: b.time,
        value: asPrice(v),
        color: isUp ? VOLUME_UP_COLOR : VOLUME_DOWN_COLOR,
      });
    }
    return out;
  }

  /**
   * SMA(period) computed self-sufficiently from this source's own OHLC —
   * never reads from the chart's cache. Pads the lookback by `period * iv`
   * so the first emitted point already has a full window.
   */
  fetchSma(
    intervalDuration: number,
    start: number,
    end: number,
    period: number = SMA_DEFAULT_PERIOD,
  ): PointRecord[] {
    if (!isValidIntervalRange(intervalDuration, start, end) || period <= 0) {
      return [];
    }
    const pad = intervalDuration * period;
    const bars = this.fetchOhlc(intervalDuration, start - pad, end);
    if (bars.length < period) {
      return [];
    }
    const closes: { time: number; close: number }[] = bars.map((b) => ({
      time: Number(b.time),
      close: Number(b.close),
    }));
    const out: PointRecord[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) {
      const e = closes[i];
      if (e === undefined) {
        return [];
      }
      sum += e.close;
    }
    const seed = closes[period - 1];
    if (seed === undefined) {
      return [];
    }
    if (seed.time >= start && seed.time <= end) {
      out.push({ time: asTime(seed.time), value: asPrice(sum / period) });
    }
    for (let i = period; i < closes.length; i++) {
      const curr = closes[i];
      const prev = closes[i - period];
      if (curr === undefined || prev === undefined) {
        continue;
      }
      sum += curr.close - prev.close;
      if (curr.time >= start && curr.time <= end) {
        out.push({ time: asTime(curr.time), value: asPrice(sum / period) });
      }
    }
    return out;
  }

  /** 5-bar pivot extrema markers. */
  fetchEvents(intervalDuration: number, start: number, end: number): MarkerRecord[] {
    if (!isValidIntervalRange(intervalDuration, start, end)) {
      return [];
    }
    const pad = intervalDuration * PIVOT_HALF_WINDOW;
    const bars = this.fetchOhlc(intervalDuration, start - pad, end + pad);
    return computePivotMarkers(bars).filter((m) => {
      const t = Number(m.time);
      return t >= start && t <= end;
    });
  }

  /**
   * One synthetic OHLC tick at `now`. Same-bar ticks return an EXTENDED
   * record (open=prev.open, high/low widened, close drifted); a tick that
   * crosses the bar boundary returns a NEW record (open=prev.close, etc.).
   * Pass `prev = null` to anchor the first tick to the source's basePrice.
   */
  tickOhlc(intervalDuration: number, now: number, prev: OhlcRecord | null): OhlcRecord {
    const barTime = Math.floor(now / intervalDuration) * intervalDuration;
    const seed = mix32(0xcafef00d, barTime / intervalDuration ^ Math.floor(now * 17));
    const rng = lcg(seed);
    const jitter = (rng() - 0.5) * this.basePrice * this.volatility * 0.5;
    // Treat any non-finite OHLC field on `prev` as if `prev` were absent — never
    // propagate NaN/Infinity into the supplied record. `prevTime` separately
    // controls whether we extend an existing bar or append a new one.
    const prevValid = prev !== null && allOhlcFinite(prev);
    const prevTime = prev !== null && Number.isFinite(Number(prev.time)) ? Number(prev.time) : Number.NaN;
    if (prevValid && prevTime === barTime) {
      const close = Math.max(0.01, Number(prev.close) + jitter);
      const high = Math.max(Number(prev.high), close);
      const low = Math.min(Number(prev.low), close);
      return {
        time: asTime(barTime),
        open: prev.open,
        high: asPrice(high),
        low: asPrice(low),
        close: asPrice(close),
        volume: (prev.volume ?? 0) + Math.floor(rng() * 100),
      };
    }
    const anchor = prevValid ? Number(prev.close) : this.basePrice;
    const open = anchor;
    const close = Math.max(0.01, open + jitter);
    const high = Math.max(open, close) + rng() * this.basePrice * 0.002;
    const low = Math.min(open, close) - rng() * this.basePrice * 0.002;
    return {
      time: asTime(barTime),
      open: asPrice(open),
      high: asPrice(high),
      low: asPrice(Math.max(0.0001, low)),
      close: asPrice(close),
      volume: Math.floor(rng() * 200) + 50,
    };
  }

  /** Volume point paired with the just-emitted OHLC tick. */
  tickVolume(intervalDuration: number, _now: number, ohlc: OhlcRecord): PointRecord {
    const priceMin = Number(ohlc.low);
    const priceMax = Number(ohlc.high);
    const band = Math.max(0.0001, priceMax - priceMin) * VOLUME_OVERLAY_BAND_FRACTION;
    const value = priceMin + band * Math.min(1, (ohlc.volume ?? 0) / 5000);
    const isUp = Number(ohlc.close) >= Number(ohlc.open);
    void intervalDuration;
    return {
      time: ohlc.time,
      value: asPrice(value),
      color: isUp ? VOLUME_UP_COLOR : VOLUME_DOWN_COLOR,
    };
  }
}

function allOhlcFinite(rec: OhlcRecord): boolean {
  return (
    Number.isFinite(Number(rec.open)) &&
    Number.isFinite(Number(rec.high)) &&
    Number.isFinite(Number(rec.low)) &&
    Number.isFinite(Number(rec.close))
  );
}

function isValidIntervalRange(intervalDuration: number, start: number, end: number): boolean {
  return (
    Number.isFinite(intervalDuration) &&
    intervalDuration > 0 &&
    Number.isInteger(intervalDuration) &&
    intervalDuration % MIN === 0 &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= end
  );
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = Math.imul(s ^ (s >>> 15), 0x85ebca6b) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 0xffffffff;
  };
}

function mix32(a: number, b: number): number {
  let h = (a ^ (b << 1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0);
}

export function scaleVolumeForOverlay(bars: readonly OhlcRecord[]): PointRecord[] {
  if (bars.length === 0) {
    return [];
  }
  let priceMin = Number.POSITIVE_INFINITY;
  let priceMax = Number.NEGATIVE_INFINITY;
  let volumeMax = 0;
  for (const b of bars) {
    const low = Number(b.low);
    const high = Number(b.high);
    if (Number.isFinite(low) && low < priceMin) {
      priceMin = low;
    }
    if (Number.isFinite(high) && high > priceMax) {
      priceMax = high;
    }
    const v = b.volume ?? 0;
    if (v > volumeMax) {
      volumeMax = v;
    }
  }
  if (
    !Number.isFinite(priceMin) ||
    !Number.isFinite(priceMax) ||
    priceMin >= priceMax ||
    volumeMax <= 0
  ) {
    return [];
  }
  const band = (priceMax - priceMin) * VOLUME_OVERLAY_BAND_FRACTION;
  const out: PointRecord[] = [];
  for (const b of bars) {
    const v = b.volume ?? 0;
    const normalized = v / volumeMax;
    const value = priceMin + normalized * band;
    const isUp = Number(b.close) >= Number(b.open);
    out.push({
      time: b.time,
      value: asPrice(value),
      color: isUp ? VOLUME_UP_COLOR : VOLUME_DOWN_COLOR,
    });
  }
  return out;
}

export function computePivotMarkers(
  bars: readonly OhlcRecord[],
  halfWindow: number = PIVOT_HALF_WINDOW,
): MarkerRecord[] {
  if (bars.length < halfWindow * 2 + 1) {
    return [];
  }
  const out: MarkerRecord[] = [];
  for (let i = halfWindow; i < bars.length - halfWindow; i++) {
    const me = bars[i];
    if (me === undefined) {
      continue;
    }
    const meHigh = Number(me.high);
    const meLow = Number(me.low);
    if (!Number.isFinite(meHigh) || !Number.isFinite(meLow)) {
      continue;
    }
    let isHigh = true;
    let isLow = true;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j === i) {
        continue;
      }
      const other = bars[j];
      if (other === undefined) {
        isHigh = false;
        isLow = false;
        break;
      }
      const oh = Number(other.high);
      const ol = Number(other.low);
      if (!Number.isFinite(oh) || !Number.isFinite(ol)) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (oh >= meHigh) {
        isHigh = false;
      }
      if (ol <= meLow) {
        isLow = false;
      }
      if (!isHigh && !isLow) {
        break;
      }
    }
    if (isHigh) {
      out.push({ time: me.time, shape: "arrowDown", position: "above" });
    } else if (isLow) {
      out.push({ time: me.time, shape: "arrowUp", position: "below" });
    }
  }
  return out;
}
