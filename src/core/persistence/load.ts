/**
 * Phase 15 Cycle A — load orchestration. Step-ordered: validate → migrate
 * → cancel inflight interactions → theme → interval → window → panes →
 * drawings → series → wait-for-data-quiet.
 */

import type {
  Interval,
  Logger,
  Theme,
  WindowInput,
} from "../../types.js";
import { asInterval, asTime } from "../../types.js";
import type { DrawingsFacade } from "../drawings/DrawingsController.js";
import type {
  ChartSaveState,
  LoadOptions,
  PaneSaveEntry,
  SeriesSaveEntry,
} from "./types.js";
import {
  CartaSchemaError,
  OperationCanceledError,
} from "./types.js";
import { migrate } from "./migrate.js";
import { AreaSeries } from "../series/AreaSeries.js";
import { BaselineSeries } from "../series/BaselineSeries.js";
import { CandlestickSeries } from "../series/CandlestickSeries.js";
import { HeikinAshiSeries } from "../series/HeikinAshiSeries.js";
import { HistogramSeries } from "../series/HistogramSeries.js";
import { LineSeries } from "../series/LineSeries.js";
import { MarkerOverlay } from "../series/MarkerOverlay.js";
import { OhlcBarSeries } from "../series/OhlcBarSeries.js";
import type { Series } from "../series/Series.js";
import { MAIN_PANE_ID, type PaneId } from "../drawings/types.js";

const QUIET_SETTLE_MS = 50;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/** Friend interface — read/write handle into the chart's internal state. */
export interface LoadContext {
  readonly logger: Logger;
  setInterval(interval: Interval): void;
  setWindow(win: WindowInput): void;
  applyTheme(name: "light" | "dark" | "custom", overrides: Partial<Theme> | undefined): void;
  /** Cancel any in-flight pointer / drag / brush state before mutating layout. */
  cancelInflightInteractions(): void;
  drawings: DrawingsFacade;
  addPane(opts: {
    id?: PaneId;
    stretchFactor?: number;
    minHeight?: number;
    height?: number | null;
    hidden?: boolean;
    collapsed?: boolean;
    header?: PaneSaveEntry["header"];
    priceScales?: PaneSaveEntry["priceScales"];
  }): void;
  removePane(id: PaneId): void;
  applyPaneOptions(id: PaneId, patch: {
    stretchFactor?: number;
    minHeight?: number;
    height?: number | null;
    hidden?: boolean;
    collapsed?: boolean;
    header?: PaneSaveEntry["header"];
    priceScales?: PaneSaveEntry["priceScales"];
  }): void;
  listPaneIds(): readonly PaneId[];
  /**
   * Phase 15 Cycle A — reorder the pane list to match `orderedIds`. Primary
   * pane stays pinned at index 0; non-primary panes are moved in order.
   * No-op when the list already matches.
   */
  reorderPanes(orderedIds: readonly PaneId[]): void;
  removeAllSeries(): void;
  addSeries(series: Series): void;
  hasPendingDataRequest(): boolean;
  isDisposed(): boolean;
  scheduleFlush(): void;
  emit(event: "state:loaded", payload: { schemaVersion: number }): void;
  emitPartial(event: "state:partial-loaded", payload: { schemaVersion: number; reason: "timeout" }): void;
}

/**
 * Validate + migrate a host-supplied state. Throws `CartaSchemaError` on
 * any invariant violation. Pure function — no side effects on the chart.
 */
export function validateAndMigrate(input: unknown): ChartSaveState {
  return migrate(input);
}

function constructSeries(entry: SeriesSaveEntry): Series {
  const o = entry.options as Record<string, unknown>;
  // Round-trip through each concrete constructor. The save-side serializer
  // materialized routing fields (paneId / priceScaleId / scaleMargins) into
  // the options blob, so the constructor receives them naturally.
  switch (entry.kind) {
    case "candle":
      return new CandlestickSeries(o as never);
    case "ohlcBar":
      return new OhlcBarSeries(o as never);
    case "heikinAshi":
      return new HeikinAshiSeries(o as never);
    case "line":
      return new LineSeries(o as never);
    case "area":
      return new AreaSeries(o as never);
    case "histogram":
      return new HistogramSeries(o as never);
    case "baseline":
      return new BaselineSeries(o as never);
    case "markerOverlay":
      return new MarkerOverlay(o as never);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new OperationCanceledError("load aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OperationCanceledError("load aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDataQuiet(
  ctx: LoadContext,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"settled" | "timeout"> {
  const start = Date.now();
  let quietSince: number | null = null;
  for (;;) {
    if (signal.aborted) {
      throw new OperationCanceledError("load aborted");
    }
    if (ctx.isDisposed()) {
      throw new OperationCanceledError("chart disposed during load");
    }
    const pending = ctx.hasPendingDataRequest();
    if (pending) {
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= QUIET_SETTLE_MS) {
      return "settled";
    }
    if (Date.now() - start >= timeoutMs) {
      return "timeout";
    }
    await sleep(16, signal);
  }
}

export async function loadChart(
  ctx: LoadContext,
  rawState: unknown,
  opts: LoadOptions,
): Promise<void> {
  const signal = opts.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw new OperationCanceledError("load aborted before start");
  }
  // Validate + migrate first so a malformed input never mutates chart state.
  const state = validateAndMigrate(rawState);

  if (ctx.isDisposed()) {
    throw new OperationCanceledError("chart disposed before load");
  }

  ctx.cancelInflightInteractions();

  // Theme — derive resolved theme + overrides. `theme.name === 'custom'`
  // means overrides contain a full theme snapshot.
  if (state.theme !== undefined) {
    if (state.theme.name === "light" || state.theme.name === "dark") {
      ctx.applyTheme(state.theme.name, state.theme.overrides);
    } else {
      // The schema validator pins `name` to 'light' | 'dark' | 'custom'.
      ctx.applyTheme("custom", state.theme.overrides);
    }
  }

  // Interval — must come before window because `setInterval` resets the
  // per-channel cache for the old interval.
  ctx.setInterval(asInterval(Number(state.intervalDuration)));

  // Window — skip when host opts into in-place hydrate.
  if (opts.preserveWindow !== true) {
    ctx.setWindow({
      startTime: asTime(Number(state.window.startTime)),
      endTime: asTime(Number(state.window.endTime)),
    });
  }

  // Panes — reconcile the saved set against the live chart. Primary pane
  // stays put; non-primary panes are removed if absent in the save, and
  // missing saved panes are added.
  if (state.panes !== undefined && state.panes.length > 0) {
    const savedById = new Map<string, PaneSaveEntry>();
    for (const p of state.panes) {
      savedById.set(String(p.id), p);
    }
    for (const liveId of ctx.listPaneIds()) {
      if (liveId === MAIN_PANE_ID) {
        continue;
      }
      if (!savedById.has(String(liveId))) {
        ctx.removePane(liveId);
      }
    }
    for (const p of state.panes) {
      const id = p.id;
      const live = ctx.listPaneIds().includes(id);
      if (!live && id !== MAIN_PANE_ID) {
        ctx.addPane({
          id,
          ...(p.stretchFactor !== undefined ? { stretchFactor: p.stretchFactor } : {}),
          ...(p.minHeight !== undefined ? { minHeight: p.minHeight } : {}),
          height: p.heightOverride ?? null,
          ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
          ...(p.collapsed !== undefined ? { collapsed: p.collapsed } : {}),
          ...(p.header !== undefined ? { header: p.header } : {}),
          ...(p.priceScales !== undefined ? { priceScales: p.priceScales } : {}),
        });
      } else {
        ctx.applyPaneOptions(id, {
          ...(p.stretchFactor !== undefined ? { stretchFactor: p.stretchFactor } : {}),
          ...(p.minHeight !== undefined ? { minHeight: p.minHeight } : {}),
          height: p.heightOverride ?? null,
          ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
          ...(p.collapsed !== undefined ? { collapsed: p.collapsed } : {}),
          ...(p.header !== undefined ? { header: p.header } : {}),
          ...(p.priceScales !== undefined ? { priceScales: p.priceScales } : {}),
        });
      }
    }
    // Final pass — reorder live panes to match the save's pane-id sequence.
    // Without this, `applyPaneOptions` mutated each pane in place but the
    // chart's `panesList` order is whatever the chart had pre-load.
    ctx.reorderPanes(state.panes.map((p) => p.id));
  }

  // Series — remove all then add from save. Determinism over patching.
  ctx.removeAllSeries();
  for (const entry of state.series) {
    const series = constructSeries(entry);
    ctx.addSeries(series);
  }

  // Drawings — bulk-apply via the existing facade method, which handles
  // schema mismatches with a warn-and-drop.
  if (state.drawings !== undefined) {
    ctx.drawings.loadSnapshot(state.drawings);
  }

  // Schedule one flush so window:change + data:request fan out before we
  // start polling for quiet.
  ctx.scheduleFlush();

  const fetchTimeoutMs =
    typeof opts.fetchTimeoutMs === "number" && opts.fetchTimeoutMs > 0
      ? opts.fetchTimeoutMs
      : DEFAULT_FETCH_TIMEOUT_MS;
  const result = await waitForDataQuiet(ctx, fetchTimeoutMs, signal);

  if (ctx.isDisposed()) {
    throw new OperationCanceledError("chart disposed during load");
  }

  if (result === "settled") {
    ctx.emit("state:loaded", { schemaVersion: state.schemaVersion });
  } else {
    ctx.emitPartial("state:partial-loaded", {
      schemaVersion: state.schemaVersion,
      reason: "timeout",
    });
  }
}

/**
 * Helper for `CartaSchemaError` re-throw paths in TimeSeriesChart.load so
 * the chart can wrap downstream errors uniformly. Exported to keep the
 * import surface small.
 */
export function isSchemaError(err: unknown): err is CartaSchemaError {
  return err instanceof CartaSchemaError;
}

