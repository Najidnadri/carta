import { asPrice, type Price, type Time } from "../types.js";

export interface PriceRange {
  readonly min: Price;
  readonly max: Price;
}

/**
 * A `PriceRangeProvider` reports the min/max price that falls inside a given
 * time window. Phase 04b uses this as the auto-scale query protocol; phase 07's
 * `Series` base will implement it.
 *
 * Returning `null` means "no data in this window". Auto-scale treats a
 * `null` reduction as "retain prior domain" — it never collapses the axis.
 */
export interface PriceRangeProvider {
  priceRangeInWindow(startTime: Time, endTime: Time): PriceRange | null;
}

/**
 * Reduces a set of providers to a single {min, max}. Non-finite values and
 * inverted ranges are filtered. Returns `null` when nothing usable is
 * reported (empty set, all null, all non-finite).
 */
export function reducePriceRanges(
  providers: ReadonlySet<PriceRangeProvider>,
  startTime: Time,
  endTime: Time,
): PriceRange | null {
  if (providers.size === 0) {
    return null;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let anyContribution = false;
  for (const provider of providers) {
    const range = safeQuery(provider, startTime, endTime);
    if (range === null) {
      continue;
    }
    const rMin = Number(range.min);
    const rMax = Number(range.max);
    if (!Number.isFinite(rMin) || !Number.isFinite(rMax) || rMin > rMax) {
      continue;
    }
    if (rMin < min) {
      min = rMin;
    }
    if (rMax > max) {
      max = rMax;
    }
    anyContribution = true;
  }
  if (!anyContribution) {
    return null;
  }
  return { min: asPrice(min), max: asPrice(max) };
}

function safeQuery(
  provider: PriceRangeProvider,
  startTime: Time,
  endTime: Time,
): PriceRange | null {
  try {
    return provider.priceRangeInWindow(startTime, endTime);
  } catch {
    return null;
  }
}
