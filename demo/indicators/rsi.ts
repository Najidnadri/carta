/**
 * Phase 14 Cycle B — 14-period RSI (Wilder smoothing). Demo-only —
 * indicator engines are explicitly out of scope for the Carta library
 * proper (master plan §8). Hosts compute their own indicators and feed
 * them via `chart.supplyData(channelId, intervalDuration, points)`.
 *
 * Returns one entry per input close. Entries before warm-up are `null`
 * (the first `period` closes can't form a valid RSI value).
 */
export function computeRsi14(closes: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: closes.length }, () => null);
  if (closes.length <= period) {
    return out;
  }

  // Wilder seed: simple averages of the first `period` gains/losses.
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a === undefined || b === undefined) {
      return out;
    }
    const delta = b - a;
    if (delta >= 0) {
      gainSum += delta;
    } else {
      lossSum -= delta;
    }
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = computeRsiFromAvg(avgGain, avgLoss);

  // Wilder smoothing: avgX = ((period - 1) * prev + current) / period.
  for (let i = period + 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a === undefined || b === undefined) {
      continue;
    }
    const delta = b - a;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = ((period - 1) * avgGain + gain) / period;
    avgLoss = ((period - 1) * avgLoss + loss) / period;
    out[i] = computeRsiFromAvg(avgGain, avgLoss);
  }
  return out;
}

function computeRsiFromAvg(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
