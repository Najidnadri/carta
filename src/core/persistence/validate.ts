/**
 * Phase 15 Cycle A — type guards for the persistence module. Zero `as`,
 * zero `any`. Each guard narrows `unknown` to its target via
 * `typeof` / `Array.isArray` / discriminator checks.
 *
 * The strategy is "fail-loud on input shape, lenient on optional fields":
 * a missing optional is accepted; a present-but-wrong-type optional
 * fails the guard. This matches the miniplan's `optional fields → omit,
 * never null` convention.
 */

import {
  CARTA_SCHEMA_VERSION,
  SERIES_KINDS,
  type ChartSaveState,
  type PaneSaveEntry,
  type SeriesKind,
  type SeriesSaveEntry,
  type WatermarkConfig,
} from "./types.js";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isPositiveInteger(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

function isNonNegativeFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function isPositiveFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function isOptional<T>(x: unknown, predicate: (v: unknown) => v is T): boolean {
  return x === undefined || predicate(x);
}

function isHexColor(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffffff;
}

function isStringOrUndefined(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}

function isSeriesKind(x: unknown): x is SeriesKind {
  if (typeof x !== "string") {
    return false;
  }
  // `includes` on a `readonly string[]` is fine; the cast is for the
  // narrowed return type only.
  return (SERIES_KINDS as readonly string[]).includes(x);
}

function isWindow(x: unknown): x is { startTime: number; endTime: number } {
  if (!isRecord(x)) {
    return false;
  }
  return isFiniteNumber(x["startTime"]) && isFiniteNumber(x["endTime"]);
}

function isSeriesOptions(x: unknown): x is Record<string, unknown> {
  if (!isRecord(x)) {
    return false;
  }
  if (typeof x["channel"] !== "string" || x["channel"].length === 0) {
    return false;
  }
  return true;
}

export function isSeriesSaveEntry(x: unknown): x is SeriesSaveEntry {
  if (!isRecord(x)) {
    return false;
  }
  if (!isSeriesKind(x["kind"])) {
    return false;
  }
  if (typeof x["channel"] !== "string" || x["channel"].length === 0) {
    return false;
  }
  if (!isSeriesOptions(x["options"])) {
    return false;
  }
  return true;
}

export function isPaneSaveEntry(x: unknown): x is PaneSaveEntry {
  if (!isRecord(x)) {
    return false;
  }
  if (typeof x["id"] !== "string" || x["id"].length === 0) {
    return false;
  }
  // Phase 15 Cycle A fix-up — stretchFactor and minHeight are integer
  // physical quantities that must be > 0; negative or zero would render
  // a pane invisible or panic the layout engine. Reject defensively at
  // the validator so a corrupt save never reaches `pane.setHeight`.
  if (!isOptional(x["stretchFactor"], isPositiveFiniteNumber)) {
    return false;
  }
  if (!isOptional(x["minHeight"], isPositiveFiniteNumber)) {
    return false;
  }
  const heightOverride = x["heightOverride"];
  if (
    heightOverride !== undefined &&
    heightOverride !== null &&
    !isNonNegativeFiniteNumber(heightOverride)
  ) {
    return false;
  }
  if (!isOptional(x["hidden"], (v): v is boolean => typeof v === "boolean")) {
    return false;
  }
  if (!isOptional(x["collapsed"], (v): v is boolean => typeof v === "boolean")) {
    return false;
  }
  const header = x["header"];
  if (header !== undefined && header !== false && !isRecord(header)) {
    return false;
  }
  const priceScales = x["priceScales"];
  if (priceScales !== undefined && !isRecord(priceScales)) {
    return false;
  }
  return true;
}

export function isWatermarkConfig(x: unknown): x is WatermarkConfig {
  if (!isRecord(x)) {
    return false;
  }
  if (!isStringOrUndefined(x["text"])) {
    return false;
  }
  if (x["position"] !== undefined && typeof x["position"] !== "string") {
    return false;
  }
  if (!isOptional(x["color"], isHexColor)) {
    return false;
  }
  if (!isOptional(x["opacity"], isFiniteNumber)) {
    return false;
  }
  if (!isOptional(x["fontSize"], isFiniteNumber)) {
    return false;
  }
  if (!isStringOrUndefined(x["fontFamily"])) {
    return false;
  }
  if (!isStringOrUndefined(x["image"])) {
    return false;
  }
  return true;
}

export function isChartSaveState(x: unknown): x is ChartSaveState {
  if (!isRecord(x)) {
    return false;
  }
  if (x["schemaVersion"] !== CARTA_SCHEMA_VERSION) {
    return false;
  }
  if (typeof x["savedAt"] !== "string") {
    return false;
  }
  if (!isWindow(x["window"])) {
    return false;
  }
  if (!isPositiveInteger(x["intervalDuration"])) {
    return false;
  }
  if (!isSeriesKind(x["chartType"])) {
    return false;
  }
  if (typeof x["primaryChannelId"] !== "string" || x["primaryChannelId"].length === 0) {
    return false;
  }
  if (!isStringOrUndefined(x["primarySymbol"])) {
    return false;
  }
  const series = x["series"];
  if (!Array.isArray(series) || !series.every(isSeriesSaveEntry)) {
    return false;
  }
  // `theme` is fully optional; if present, must be a record with the right shape.
  const theme = x["theme"];
  if (theme !== undefined) {
    if (!isRecord(theme)) {
      return false;
    }
    const name = theme["name"];
    if (typeof name !== "string") {
      return false;
    }
    const overrides = theme["overrides"];
    if (overrides !== undefined && !isRecord(overrides)) {
      return false;
    }
  }
  const drawings = x["drawings"];
  if (drawings !== undefined) {
    if (!isRecord(drawings)) {
      return false;
    }
    if (drawings["schemaVersion"] !== 1) {
      return false;
    }
    if (!Array.isArray(drawings["drawings"])) {
      return false;
    }
  }
  const panes = x["panes"];
  if (panes !== undefined) {
    if (!Array.isArray(panes) || !panes.every(isPaneSaveEntry)) {
      return false;
    }
    // Phase 15 Cycle A fix-up — cross-field check for duplicate pane IDs.
    // Per-entry validation accepts each one individually, but a corrupt
    // save with two `{id:'main'}` entries would pass through to the load
    // pipeline and explode partway, leaving the chart half-applied.
    const seenIds = new Set<string>();
    for (const p of panes) {
      // `panes.every(isPaneSaveEntry)` already returned true above; the
      // redundant guard here narrows `p` to PaneSaveEntry for TS without
      // an `as` cast.
      if (!isPaneSaveEntry(p)) {
        return false;
      }
      if (seenIds.has(p.id)) {
        return false;
      }
      seenIds.add(p.id);
    }
  }
  const app = x["app"];
  if (app !== undefined) {
    if (!isRecord(app)) {
      return false;
    }
    if (typeof app["name"] !== "string" || typeof app["version"] !== "string") {
      return false;
    }
  }
  const ui = x["ui"];
  if (ui !== undefined) {
    if (!isRecord(ui)) {
      return false;
    }
    if (!isOptional(ui["trackingMode"], (v): v is boolean => typeof v === "boolean")) {
      return false;
    }
    if (ui["watermark"] !== undefined && !isWatermarkConfig(ui["watermark"])) {
      return false;
    }
  }
  return true;
}
