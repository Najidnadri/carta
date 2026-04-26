/**
 * Phase 13 Cycle B.2 — pure clamp + readout math for long / short position
 * tools. No Pixi imports. Used by `DrawingsController` (drag clamp,
 * materialize) and the demo P&L panel (stat readouts).
 *
 * Invariants:
 *   long  ⇒ sl < entry < tp
 *   short ⇒ tp < entry < sl
 *
 * The clamp helpers preserve user intent — they nudge the offending value to
 * `entry ± epsilon` rather than swapping with another field. `epsilon` is a
 * symbolic 1e-9; downstream rendering uses `Math.max(0, h)` so a 1e-9-tall
 * zone collapses to a no-op visually.
 */

import type { DisplayMode } from "./types.js";

const EPSILON = 1e-9;

export interface PositionPrices {
  readonly entry: number;
  readonly sl: number;
  readonly tp: number;
}

/**
 * Clamp prices so `sl < entry < tp`. The handle the user is dragging is the
 * one that wins in case of conflict — callers pass `pinned` to indicate which
 * field should never move (typically the dragged handle is `pinned`, others
 * adjust if they violate the invariant).
 *
 * Default: nothing pinned → `entry` wins; sl/tp clamp to entry ± epsilon.
 */
export function clampLongPosition(prices: PositionPrices, pinned?: keyof PositionPrices): PositionPrices {
  let { entry, sl, tp } = prices;
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
    return prices;
  }
  if (pinned === "sl") {
    if (entry <= sl) {
      entry = sl + EPSILON;
    }
    if (tp <= entry) {
      tp = entry + EPSILON;
    }
  } else if (pinned === "tp") {
    if (entry >= tp) {
      entry = tp - EPSILON;
    }
    if (sl >= entry) {
      sl = entry - EPSILON;
    }
  } else {
    if (sl >= entry) {
      sl = entry - EPSILON;
    }
    if (tp <= entry) {
      tp = entry + EPSILON;
    }
  }
  return { entry, sl, tp };
}

export function clampShortPosition(prices: PositionPrices, pinned?: keyof PositionPrices): PositionPrices {
  let { entry, sl, tp } = prices;
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
    return prices;
  }
  if (pinned === "sl") {
    if (entry >= sl) {
      entry = sl - EPSILON;
    }
    if (tp >= entry) {
      tp = entry - EPSILON;
    }
  } else if (pinned === "tp") {
    if (entry <= tp) {
      entry = tp + EPSILON;
    }
    if (sl <= entry) {
      sl = entry + EPSILON;
    }
  } else {
    if (sl <= entry) {
      sl = entry + EPSILON;
    }
    if (tp >= entry) {
      tp = entry - EPSILON;
    }
  }
  return { entry, sl, tp };
}

export interface PositionStatsInput extends PositionPrices {
  readonly qty: number;
  readonly tickSize?: number;
  readonly displayMode: DisplayMode;
  /** `'long'` or `'short'` — affects sign of P&L per leg. */
  readonly side: "long" | "short";
}

export interface PositionStats {
  /** Reward / risk ratio. `Infinity` when risk == 0. `null` when undefined. */
  readonly riskReward: number | null;
  /** Profit-leg price delta (`tp - entry` for long; `entry - tp` for short). */
  readonly rewardDelta: number;
  /** Loss-leg price delta (`entry - sl` for long; `sl - entry` for short). */
  readonly riskDelta: number;
  /** Reward as a percent of entry price (`rewardDelta / entry * 100`). */
  readonly rewardPct: number | null;
  readonly riskPct: number | null;
  /** Reward / risk in ticks (when `tickSize` defined). */
  readonly rewardTicks: number | null;
  readonly riskTicks: number | null;
}

/**
 * Compute readout values for a position. Returns NaN/Infinity-safe values; the
 * formatter is the caller's job (see `formatPositionLine`).
 */
export function computePositionStats(input: PositionStatsInput): PositionStats {
  const { entry, sl, tp, side, tickSize } = input;
  const finite = Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp);
  if (!finite) {
    return Object.freeze({
      riskReward: null,
      rewardDelta: Number.NaN,
      riskDelta: Number.NaN,
      rewardPct: null,
      riskPct: null,
      rewardTicks: null,
      riskTicks: null,
    });
  }
  const rewardDelta = side === "long" ? tp - entry : entry - tp;
  const riskDelta = side === "long" ? entry - sl : sl - entry;
  const absReward = Math.abs(rewardDelta);
  const absRisk = Math.abs(riskDelta);
  let riskReward: number | null;
  if (absRisk === 0) {
    riskReward = absReward === 0 ? null : Number.POSITIVE_INFINITY;
  } else {
    riskReward = absReward / absRisk;
  }
  const entryPct = entry === 0 ? null : 100 / entry;
  const rewardPct = entryPct === null ? null : rewardDelta * entryPct;
  const riskPct = entryPct === null ? null : riskDelta * entryPct;
  const ts = Number.isFinite(tickSize) && (tickSize ?? 0) > 0 ? (tickSize as number) : null;
  const rewardTicks = ts === null ? null : Math.round(rewardDelta / ts);
  const riskTicks = ts === null ? null : Math.round(riskDelta / ts);
  return Object.freeze({
    riskReward,
    rewardDelta,
    riskDelta,
    rewardPct,
    riskPct,
    rewardTicks,
    riskTicks,
  });
}

/**
 * Format a single readout line per `displayMode`. Used by the renderer for
 * the per-zone in-band labels. Keep output ASCII-only so the `BitmapText`
 * atlas seed covers it (`%` `:` `+` `-` `.` digits).
 */
export function formatPositionLine(
  stats: PositionStats,
  displayMode: DisplayMode,
  zone: "reward" | "risk",
  priceFormatter: (v: number) => string,
): string {
  const delta = zone === "reward" ? stats.rewardDelta : stats.riskDelta;
  if (!Number.isFinite(delta)) {
    return "—";
  }
  switch (displayMode) {
    case "rr": {
      if (zone === "reward" && stats.riskReward !== null) {
        const rr = stats.riskReward;
        if (!Number.isFinite(rr)) {
          return "R:R ∞";
        }
        return `R:R ${rr.toFixed(2)}`;
      }
      const sign = delta >= 0 ? "+" : "-";
      return `${sign}${priceFormatter(Math.abs(delta))}`;
    }
    case "price": {
      const sign = delta >= 0 ? "+" : "-";
      return `${sign}${priceFormatter(Math.abs(delta))}`;
    }
    case "percent": {
      const pct = zone === "reward" ? stats.rewardPct : stats.riskPct;
      if (pct === null || !Number.isFinite(pct)) {
        return "—";
      }
      const sign = pct >= 0 ? "+" : "-";
      return `${sign}${Math.abs(pct).toFixed(2)}%`;
    }
    case "ticks": {
      const t = zone === "reward" ? stats.rewardTicks : stats.riskTicks;
      if (t === null) {
        return "—";
      }
      const sign = t >= 0 ? "+" : "-";
      return `${sign}${String(Math.abs(t))}t`;
    }
  }
}
