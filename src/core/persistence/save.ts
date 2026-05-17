/**
 * Phase 15 Cycle A — pure save-side helper. Reads from the chart's
 * internals through a friend interface (`SaveContext`) so this module
 * stays imperative-free and easy to unit-test in isolation.
 */

import {
  asInterval,
  asTime,
  type Interval,
  type PriceScaleOptions,
  type Theme,
  type Time,
} from "../../types.js";
import { AreaSeries } from "../series/AreaSeries.js";
import { BaselineSeries } from "../series/BaselineSeries.js";
import { CandlestickSeries } from "../series/CandlestickSeries.js";
import { HeikinAshiSeries } from "../series/HeikinAshiSeries.js";
import { HistogramSeries } from "../series/HistogramSeries.js";
import { LineSeries } from "../series/LineSeries.js";
import { MarkerOverlay } from "../series/MarkerOverlay.js";
import { OhlcBarSeries } from "../series/OhlcBarSeries.js";
import { Series } from "../series/Series.js";
import { DarkTheme, LightTheme } from "../infra/themes.js";
import type { Pane } from "../pane/Pane.js";
import type { DrawingsSnapshot } from "../drawings/types.js";
import type {
  ChartSaveState,
  PaneSaveEntry,
  SeriesKind,
  SeriesSaveEntry,
} from "./types.js";
import { CARTA_SCHEMA_VERSION } from "./types.js";
import type { Logger } from "../../types.js";

void Series; // base type referenced via instanceof checks above only.

/** Friend interface — read-only handle into the chart's internal state. */
export interface SaveContext {
  readonly window: { startTime: Time; endTime: Time };
  readonly intervalDuration: Interval;
  readonly theme: Theme;
  readonly themeExplicitKeys: ReadonlySet<keyof Theme>;
  readonly series: readonly Series[];
  readonly seriesPaneById: ReadonlyMap<Series, string>;
  readonly seriesScaleById: ReadonlyMap<Series, string>;
  readonly panes: readonly Pane[];
  readonly drawings: DrawingsSnapshot;
  readonly logger: Logger;
  readonly persistence: { getSymbol?: (channelId: string) => string | undefined };
  readonly trackingActive: boolean;
}

function classifySeries(series: Series): SeriesKind {
  if (series instanceof CandlestickSeries) {
    return "candle";
  }
  if (series instanceof OhlcBarSeries) {
    return "ohlcBar";
  }
  if (series instanceof HeikinAshiSeries) {
    return "heikinAshi";
  }
  if (series instanceof LineSeries) {
    return "line";
  }
  if (series instanceof AreaSeries) {
    return "area";
  }
  if (series instanceof HistogramSeries) {
    return "histogram";
  }
  if (series instanceof BaselineSeries) {
    return "baseline";
  }
  if (series instanceof MarkerOverlay) {
    return "markerOverlay";
  }
  // Unreachable: every concrete carta series is enumerated above. A custom
  // host-side Series subclass cannot round-trip through save/load (its
  // constructor lives outside Carta), so we fail loud rather than emit a
  // truncated entry.
  throw new Error(
    `[carta] save: unknown Series subclass — only built-in series can be saved`,
  );
}

function buildSeriesEntry(
  series: Series,
  paneId: string,
  scaleId: string,
): SeriesSaveEntry {
  const kind = classifySeries(series);
  const baseOpts = series.getOptions();
  // Materialize routing fields into the saved options so re-creation goes
  // through the standard constructor surface — same fields the host would
  // have passed at construction time. Channel pinning happens inside the
  // series' constructor; we don't have to special-case it here.
  const opts: Readonly<Record<string, unknown>> = {
    ...baseOpts,
    channel: series.channel,
    paneId,
    priceScaleId: scaleId,
    ...(series.scaleMargins !== undefined ? { scaleMargins: series.scaleMargins } : {}),
  };
  // Discriminated-union entry — `kind` selects the concrete branch.
  switch (kind) {
    case "candle":
      return { kind, channel: series.channel, options: opts as never };
    case "ohlcBar":
      return { kind, channel: series.channel, options: opts as never };
    case "heikinAshi":
      return { kind, channel: series.channel, options: opts as never };
    case "line":
      return { kind, channel: series.channel, options: opts as never };
    case "area":
      return { kind, channel: series.channel, options: opts as never };
    case "histogram":
      return { kind, channel: series.channel, options: opts as never };
    case "baseline":
      return { kind, channel: series.channel, options: opts as never };
    case "markerOverlay":
      return { kind, channel: series.channel, options: opts as never };
  }
}

function buildPaneEntry(pane: Pane): PaneSaveEntry {
  // Per-slot price-scale mode snapshot. Cycle A handles right + left slots
  // (the only slots Carta currently uses).
  const rightScale = pane.scales().find((s) => s.id === "right");
  const leftScale = pane.scales().find((s) => s.id === "left");
  const priceScalesBuilder: {
    right?: PriceScaleOptions;
    left?: PriceScaleOptions;
  } = {};
  if (rightScale !== undefined) {
    priceScalesBuilder.right = { margins: rightScale.margins, mode: rightScale.mode };
  }
  if (leftScale !== undefined) {
    priceScalesBuilder.left = { margins: leftScale.margins, mode: leftScale.mode };
  }
  const hasPriceScales =
    priceScalesBuilder.right !== undefined || priceScalesBuilder.left !== undefined;
  // Build header field — `false` (header explicitly off) and `undefined`
  // (default) round-trip identically since the loader only acts on a
  // non-false value.
  const header = pane.headerOptions ?? undefined;
  const entry: PaneSaveEntry = {
    id: pane.id,
    stretchFactor: pane.stretchFactor,
    minHeight: pane.minHeight,
    heightOverride: pane.heightOverride,
    hidden: pane.hidden,
    collapsed: pane.collapsed,
    ...(header !== undefined ? { header } : {}),
    ...(hasPriceScales ? { priceScales: priceScalesBuilder } : {}),
  };
  return entry;
}

function classifyTheme(theme: Theme): "light" | "dark" | "custom" {
  if (theme === DarkTheme) {
    return "dark";
  }
  if (theme === LightTheme) {
    return "light";
  }
  return "custom";
}

function buildThemeOverrides(
  theme: Theme,
  explicit: ReadonlySet<keyof Theme>,
): Partial<Theme> {
  const out: Partial<Theme> = {};
  if (explicit.size === 0) {
    return out;
  }
  // Walk the explicit set; copy the live value for each marked key. We
  // type-narrow via a per-key write so no `as unknown` is needed.
  for (const key of explicit) {
    // Cast is internal: `Theme` is structurally typed; the same key on
    // the resolved theme is type-safe by construction.
    (out as Record<string, unknown>)[key] = theme[key];
  }
  return out;
}

export function pickPrimaryChannelId(series: readonly Series[]): string {
  for (const s of series) {
    if (s.kind === "ohlc") {
      return s.channel;
    }
  }
  return series[0]?.channel ?? "primary";
}

function resolvePrimarySymbol(
  primaryChannelId: string,
  ctx: SaveContext,
): string | undefined {
  const getSymbol = ctx.persistence.getSymbol;
  if (getSymbol === undefined) {
    return undefined;
  }
  try {
    const sym = getSymbol(primaryChannelId);
    if (typeof sym === "string" && sym.length > 0) {
      return sym;
    }
    return undefined;
  } catch (err: unknown) {
    ctx.logger.warn(
      `[carta] save: persistence.getSymbol threw — primarySymbol omitted`,
      err,
    );
    return undefined;
  }
}

export function saveChart(ctx: SaveContext): ChartSaveState {
  const seriesEntries: SeriesSaveEntry[] = [];
  for (const s of ctx.series) {
    const paneId = ctx.seriesPaneById.get(s) ?? "main";
    const scaleId = ctx.seriesScaleById.get(s) ?? "right";
    seriesEntries.push(buildSeriesEntry(s, paneId, scaleId));
  }
  const paneEntries: PaneSaveEntry[] = ctx.panes.map(buildPaneEntry);
  const primaryChannelId = pickPrimaryChannelId(ctx.series);
  const primarySymbol = resolvePrimarySymbol(primaryChannelId, ctx);
  const themeName = classifyTheme(ctx.theme);
  const themeOverrides = buildThemeOverrides(ctx.theme, ctx.themeExplicitKeys);
  const themeBlock =
    themeName !== "custom" && Object.keys(themeOverrides).length === 0
      ? { name: themeName }
      : themeName === "custom"
        ? { name: themeName, overrides: { ...ctx.theme } }
        : { name: themeName, overrides: themeOverrides };
  // Pick a primary chart type — the kind of the first OHLC-style series
  // we find, else fall back to the first series, else 'candle' as default.
  let chartType: SeriesKind = "candle";
  for (const e of seriesEntries) {
    if (e.kind === "candle" || e.kind === "ohlcBar" || e.kind === "heikinAshi") {
      chartType = e.kind;
      break;
    }
    if (chartType === "candle" && e.kind !== "markerOverlay") {
      chartType = e.kind;
    }
  }
  const state: ChartSaveState = {
    schemaVersion: CARTA_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    window: {
      startTime: asTime(Number(ctx.window.startTime)),
      endTime: asTime(Number(ctx.window.endTime)),
    },
    intervalDuration: asInterval(Number(ctx.intervalDuration)),
    chartType,
    theme: themeBlock,
    primaryChannelId,
    ...(primarySymbol !== undefined ? { primarySymbol } : {}),
    series: seriesEntries,
    drawings: ctx.drawings,
    panes: paneEntries,
    ui: {
      trackingMode: ctx.trackingActive,
    },
  };
  return state;
}
