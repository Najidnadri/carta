/**
 * Phase 14 Cycle B — demo-only indicator helpers used by the 5-pane
 * preset. Computes RSI / MACD / z-score on host-side, then pushes the
 * results into Carta via `chart.supplyData(channelId, intervalDuration,
 * points)`. Master plan §8 explicitly bars indicator engines from `src/`.
 */
export { computeRsi14 } from "./rsi.js";
export { computeMacd, type MacdResult } from "./macd.js";
export { computeZScore } from "./zscore.js";
