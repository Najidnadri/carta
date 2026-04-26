import type { Theme } from "../../types.js";

/** System-default font stack — no shipped atlases. Hosts swap via `theme.fontFamily`. */
const DEFAULT_FONT_FAMILY =
  "system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
const DEFAULT_FONT_SIZE = 11;

/**
 * Default theme — dark surface. Mirrors the GitHub Primer palette so the demo
 * feels at home in a dev-tool context. Used at construction when
 * `TimeSeriesChartOptions.theme` is absent.
 */
export const DarkTheme: Theme = {
  background: 0x0e1116,
  grid: 0x1f2630,
  gridAlpha: 1,
  frame: 0x2d333b,
  text: 0xc9d1d9,
  textMuted: 0x8b949e,
  up: 0x26a69a,
  down: 0xef5350,
  line: 0x58a6ff,
  areaTop: 0x58a6ff,
  areaBottom: 0x58a6ff,
  histogramUp: 0x26a69a,
  histogramDown: 0xef5350,
  baselinePositiveTop: 0x26a69a,
  baselinePositiveBottom: 0x26a69a,
  baselineNegativeTop: 0xef5350,
  baselineNegativeBottom: 0xef5350,
  crosshairLine: 0x8b949e,
  crosshairTagBg: 0x1f2630,
  crosshairTagText: 0xc9d1d9,
  selection: 0x58a6ff,
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
};

/**
 * Light surface preset. Palette derived from TradingView Lightweight Charts
 * with WCAG-AA-compliant text contrast against `#FFFFFF`. Up/down hues
 * desaturated from the dark variant so candle bodies don't look neon on the
 * light background. `gridAlpha: 0.6` so grid lines don't compete with bars.
 */
export const LightTheme: Theme = {
  background: 0xffffff,
  grid: 0xe1e4e8,
  gridAlpha: 0.6,
  frame: 0xd0d7de,
  text: 0x24292f, // 12.6:1 on white — passes AAA
  textMuted: 0x57606a, // 5.6:1 on white — passes AA
  up: 0x089981,
  down: 0xe13443,
  line: 0x2962ff,
  areaTop: 0x2962ff,
  areaBottom: 0x2962ff,
  histogramUp: 0x089981,
  histogramDown: 0xe13443,
  baselinePositiveTop: 0x089981,
  baselinePositiveBottom: 0x089981,
  baselineNegativeTop: 0xe13443,
  baselineNegativeBottom: 0xe13443,
  crosshairLine: 0x9098a1,
  crosshairTagBg: 0x24292f,
  crosshairTagText: 0xffffff,
  selection: 0x2962ff,
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
};
