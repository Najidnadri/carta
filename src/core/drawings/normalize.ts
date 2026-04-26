/**
 * Phase 13 — `chart.drawings.add()` boundary normalizer.
 *
 * TypeScript types declare every drawing field required, but at runtime
 * hosts can build drawings via JSON or plain JS and reach `add()` with
 * partial shapes.  This helper fills missing optional / kind-specific
 * defaults once at the boundary so the renderer never sees a partial
 * drawing.  When a partial shape violates a hard invariant (e.g.
 * long-position requires `sl < entry < tp`), we return a `null` drawing
 * and a `warn` string for the controller to log.  This is soft-fail per
 * master-plan §5 ("strict TS at public API"); loadSnapshot still drops
 * such records via the parser path.
 */

import { asTime } from "../../types.js";
import type { Drawing, DrawingStyle, FibLevel, DisplayMode, PitchforkVariant } from "./types.js";
import { DEFAULT_FIB_LEVELS } from "./types.js";

export interface NormalizeResult {
  readonly drawing: Drawing | null;
  readonly warn: string | null;
}

const DEFAULT_END_TIME_BARS = 12;

interface RawShape {
  style?: DrawingStyle | null;
  levels?: readonly FibLevel[] | null;
  endTime?: number | null;
  displayMode?: string | null;
  qty?: number | null;
  tickSize?: number | null;
  text?: string | null;
  variant?: string | null;
}

function isValidPitchforkVariant(s: unknown): s is PitchforkVariant {
  return s === "andrews" || s === "schiff" || s === "modifiedSchiff";
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function isValidDisplayMode(s: unknown): s is DisplayMode {
  return s === "rr" || s === "percent" || s === "price" || s === "ticks";
}

/**
 * @param d        The drawing reaching `chart.drawings.add()`.
 * @param intervalMs  Active chart interval in ms (used to default position
 *                 `endTime`).  Pass `0` when none is available — we then
 *                 require `endTime` from the host.
 */
export function normalizeDrawingDefaults(d: Drawing, intervalMs: number): NormalizeResult {
  const view = d as unknown as RawShape;
  const styleFill = view.style === undefined || view.style === null;
  const baseStyle: DrawingStyle = styleFill ? Object.freeze({} as DrawingStyle) : d.style;

  if (d.kind === "fibRetracement") {
    const levelsFill =
      view.levels === undefined || view.levels === null || !Array.isArray(view.levels);
    if (!styleFill && !levelsFill) {
      return { drawing: d, warn: null };
    }
    return {
      drawing: Object.freeze({
        ...d,
        style: baseStyle,
        levels: levelsFill ? DEFAULT_FIB_LEVELS : d.levels,
      }),
      warn: null,
    };
  }

  if (d.kind === "longPosition" || d.kind === "shortPosition") {
    return normalizePosition(d, view, baseStyle, intervalMs);
  }

  if (d.kind === "text" || d.kind === "callout") {
    const textFill = typeof view.text !== "string";
    if (!styleFill && !textFill) {
      return { drawing: d, warn: null };
    }
    return {
      drawing: Object.freeze({
        ...d,
        style: baseStyle,
        text: textFill ? "" : d.text,
      }),
      warn: null,
    };
  }

  if (d.kind === "pitchfork") {
    const rawVariant = (d as unknown as { variant?: unknown }).variant;
    const variantMissing = rawVariant === undefined || rawVariant === null;
    const variantValid = isValidPitchforkVariant(rawVariant);
    const variant: PitchforkVariant = variantValid ? rawVariant : "andrews";
    if (!styleFill && variantValid) {
      return { drawing: d, warn: null };
    }
    const warn = !variantMissing && !variantValid
      ? `pitchfork unknown variant ${String(rawVariant)} — defaulted to 'andrews'`
      : null;
    return {
      drawing: Object.freeze({
        ...d,
        style: baseStyle,
        variant,
      }),
      warn,
    };
  }

  // All other kinds: only the style field can be missing.
  if (!styleFill) {
    return { drawing: d, warn: null };
  }
  return {
    drawing: Object.freeze({ ...d, style: baseStyle }),
    warn: null,
  };
}

function normalizePosition(
  d: Drawing & { kind: "longPosition" | "shortPosition" },
  view: RawShape,
  baseStyle: DrawingStyle,
  intervalMs: number,
): NormalizeResult {
  // Hosts can pass partial anchors at runtime even though TS types declare
  // a 3-tuple — narrow defensively before reading.
  const anchors = (d as unknown as { anchors?: readonly { time: unknown; price: unknown }[] }).anchors;
  const a0 = anchors?.[0];
  const a1 = anchors?.[1];
  const a2 = anchors?.[2];
  if (a0 === undefined || a1 === undefined || a2 === undefined) {
    return { drawing: null, warn: `${d.kind} missing anchor` };
  }
  const entryPrice = typeof a0.price === "number" ? a0.price : Number.NaN;
  const slPrice = typeof a1.price === "number" ? a1.price : Number.NaN;
  const tpPrice = typeof a2.price === "number" ? a2.price : Number.NaN;
  const isLong = d.kind === "longPosition";
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(slPrice) ||
    !Number.isFinite(tpPrice)
  ) {
    return { drawing: null, warn: `${d.kind} non-finite price anchor` };
  }
  const ok = isLong
    ? slPrice < entryPrice && entryPrice < tpPrice
    : tpPrice < entryPrice && entryPrice < slPrice;
  if (!ok) {
    return {
      drawing: null,
      warn: `${d.kind} invariant violated (need ${isLong ? "sl < entry < tp" : "tp < entry < sl"})`,
    };
  }
  const givenEnd = view.endTime;
  const entryTime = typeof a0.time === "number" ? a0.time : Number.NaN;
  let endTime: number;
  if (typeof givenEnd === "number" && Number.isFinite(givenEnd) && givenEnd > entryTime) {
    endTime = givenEnd;
  } else if (intervalMs > 0) {
    endTime = entryTime + DEFAULT_END_TIME_BARS * intervalMs;
  } else {
    return { drawing: null, warn: `${d.kind} missing endTime and chart has no interval` };
  }
  const qty = isFinitePositive(view.qty) ? view.qty : 1;
  const displayMode: DisplayMode = isValidDisplayMode(view.displayMode) ? view.displayMode : "rr";
  const base = {
    ...d,
    style: baseStyle,
    endTime: asTime(endTime),
    qty,
    displayMode,
  };
  const tickSize = view.tickSize;
  const final = isFinitePositive(tickSize) ? { ...base, tickSize } : base;
  return { drawing: Object.freeze(final) as Drawing, warn: null };
}
