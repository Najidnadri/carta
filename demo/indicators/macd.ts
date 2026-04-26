/**
 * Phase 14 Cycle B — 12/26/9 MACD. Demo-only (indicator math is host
 * concern per master plan §8).
 *
 * Returns three parallel arrays: `macd` (12-EMA - 26-EMA), `signal`
 * (9-EMA of the MACD line), and `hist` (MACD - signal). Entries before
 * the slow EMA warms up are `null`.
 */
export interface MacdResult {
  readonly macd: (number | null)[];
  readonly signal: (number | null)[];
  readonly hist: (number | null)[];
}

export function computeMacd(
  closes: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = computeEma(closes, fastPeriod);
  const slow = computeEma(closes, slowPeriod);
  const macd: (number | null)[] = Array.from({ length: closes.length }, () => null);
  for (let i = 0; i < closes.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (f !== null && s !== null && f !== undefined && s !== undefined) {
      macd[i] = f - s;
    }
  }
  // Signal is a 9-EMA of the MACD line; use a derivative EMA that skips
  // null prefix entries (Wilder convention: warmup runs only over valid
  // input, then EMA after).
  const signal = computeEmaWithGaps(macd, signalPeriod);
  const hist: (number | null)[] = Array.from({ length: closes.length }, () => null);
  for (let i = 0; i < closes.length; i += 1) {
    const m = macd[i];
    const s = signal[i];
    if (m !== null && s !== null && m !== undefined && s !== undefined) {
      hist[i] = m - s;
    }
  }
  return { macd, signal, hist };
}

function computeEma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length < period) {
    return out;
  }
  // Seed with simple average of the first `period` values.
  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    seed += values[i] ?? 0;
  }
  let ema = seed / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    const v = values[i];
    if (v === undefined) {
      out[i] = null;
      continue;
    }
    ema = v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeEmaWithGaps(values: readonly (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: values.length }, () => null);
  let validCount = 0;
  let seedSum = 0;
  let ema: number | null = null;
  const k = 2 / (period + 1);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === null || v === undefined) {
      continue;
    }
    if (ema === null) {
      seedSum += v;
      validCount += 1;
      if (validCount === period) {
        ema = seedSum / period;
        out[i] = ema;
      }
      continue;
    }
    ema = v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}
