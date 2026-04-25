import { asPrice, asTime, type OhlcRecord, type Price, type Time } from "../../types.js";

/**
 * A derived Heikin-Ashi bar. Shape mirrors `OhlcRecord` so the same
 * `drawCandleGlyph` helper can paint it, but the values are HA-derived:
 *
 *   HA_close = (O + H + L + C) / 4
 *   HA_open  = (prev HA_open + prev HA_close) / 2
 *              seed: HA_open[0] = (O[0] + C[0]) / 2
 *   HA_high  = max(H, HA_open, HA_close)
 *   HA_low   = min(L, HA_open, HA_close)
 */
export interface HeikinAshiBar {
  readonly time: Time;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
}

/**
 * Seed state for forward-iteration HA computation. Callers that need to
 * resume from a prior tail (e.g. cached recomputation) pass the previous
 * tail's HA open+close; first-time callers pass `null`.
 */
export interface HeikinAshiSeed {
  readonly prevHaOpen: number;
  readonly prevHaClose: number;
}

function isFiniteOhlc(r: OhlcRecord): boolean {
  return (
    Number.isFinite(Number(r.open)) &&
    Number.isFinite(Number(r.high)) &&
    Number.isFinite(Number(r.low)) &&
    Number.isFinite(Number(r.close))
  );
}

/**
 * Compute Heikin-Ashi bars from a time-sorted OhlcRecord array. When `seed`
 * is `null` the first emitted bar uses `HA_open = (O[0] + C[0]) / 2` —
 * matches the canonical definition. Non-finite records are skipped without
 * advancing the recursive state, so a bad tick doesn't poison the rest of
 * the series.
 *
 * The input must be monotonically non-decreasing in `time`; non-monotonic
 * entries are skipped (HA is only well-defined for ordered series).
 */
export function computeHeikinAshi(
  records: readonly OhlcRecord[],
  seed: HeikinAshiSeed | null = null,
): HeikinAshiBar[] {
  if (records.length === 0) {
    return [];
  }
  const out: HeikinAshiBar[] = [];
  let prevHaOpen = seed === null ? Number.NaN : seed.prevHaOpen;
  let prevHaClose = seed === null ? Number.NaN : seed.prevHaClose;
  let prevTime: number = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    if (!isFiniteOhlc(r)) {
      continue;
    }
    const t = Number(r.time);
    if (!Number.isFinite(t) || t <= prevTime) {
      continue;
    }
    const o = Number(r.open);
    const h = Number(r.high);
    const l = Number(r.low);
    const c = Number(r.close);
    const haClose = (o + h + l + c) / 4;
    const haOpen =
      Number.isFinite(prevHaOpen) && Number.isFinite(prevHaClose)
        ? (prevHaOpen + prevHaClose) / 2
        : (o + c) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow = Math.min(l, haOpen, haClose);
    out.push({
      time: asTime(t),
      open: asPrice(haOpen),
      high: asPrice(haHigh),
      low: asPrice(haLow),
      close: asPrice(haClose),
    });
    prevHaOpen = haOpen;
    prevHaClose = haClose;
    prevTime = t;
  }
  return out;
}
