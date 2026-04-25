import type { Graphics } from "pixi.js";

export const MIN_CANDLE_BODY_HEIGHT_PX = 1;

export interface CandleGlyphInput {
  readonly x: number;
  readonly yOpen: number;
  readonly yClose: number;
  readonly yHigh: number;
  readonly yLow: number;
  readonly color: number;
  readonly wickWidth: number;
  readonly half: number;
}

/**
 * Paint one candle (wick + body) into a cleared `Graphics`. Shared by
 * `CandlestickSeries` and `HeikinAshiSeries` — the two series differ only
 * in where the OHLC values come from, never in how a single candle is
 * drawn. Caller is responsible for calling `g.clear()` first.
 *
 * Axis-aligned wick stroke uses `pixelLine: true` when `wickWidth === 1`
 * so single-pixel wicks stay crisp regardless of device-pixel ratio.
 */
export function drawCandleGlyph(g: Graphics, input: CandleGlyphInput): void {
  const { x, yOpen, yClose, yHigh, yLow, color, wickWidth, half } = input;
  const bodyTop = Math.min(yOpen, yClose);
  const bodyHeight = Math.max(MIN_CANDLE_BODY_HEIGHT_PX, Math.abs(yClose - yOpen));
  g.moveTo(x, yHigh)
    .lineTo(x, yLow)
    .stroke({ color, width: wickWidth, pixelLine: wickWidth === 1 });
  g.rect(x - half, bodyTop, half * 2, bodyHeight).fill(color);
}
