/**
 * Phase 14 Cycle B — rolling Z-score of close. Demo-only — used by the
 * 5-pane preset to populate the custom oscillator pane (bounded
 * `[-3, 3]`). Returns one entry per close; pre-warmup entries are `null`.
 */
export function computeZScore(closes: readonly number[], window = 20): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: closes.length }, () => null);
  if (closes.length < window) {
    return out;
  }
  for (let i = window - 1; i < closes.length; i += 1) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j += 1) {
      sum += closes[j] ?? 0;
    }
    const mean = sum / window;
    let varSum = 0;
    for (let j = i - window + 1; j <= i; j += 1) {
      const d = (closes[j] ?? 0) - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / window);
    if (std === 0) {
      out[i] = 0;
      continue;
    }
    out[i] = ((closes[i] ?? 0) - mean) / std;
  }
  return out;
}
