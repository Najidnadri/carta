/**
 * JSON validators for drawings. Used by `loadSnapshot()` to parse host-
 * supplied data without `as` casts on the I/O boundary. Unknown `kind` and
 * malformed records are returned as `null` — the caller logs + drops.
 */

import { asPrice, asTime } from "../../types.js";
import type {
  ArrowDrawing,
  CalloutDrawing,
  DateRangeDrawing,
  DisplayMode,
  Drawing,
  DrawingAnchor,
  DrawingFill,
  DrawingId,
  DrawingKind,
  DrawingsSnapshot,
  DrawingStroke,
  DrawingStyle,
  DrawingTextStyle,
  EllipseDrawing,
  ExtendedLineDrawing,
  ExtendMode,
  FibArcsDrawing,
  FibExtensionDrawing,
  FibFanDrawing,
  FibLevel,
  FibRetracementDrawing,
  FibTimeZonesDrawing,
  GannFanDrawing,
  HorizontalLineDrawing,
  HorizontalRayDirection,
  HorizontalRayDrawing,
  IconDrawing,
  IconGlyph,
  JsonValue,
  LongPositionDrawing,
  PaneId,
  ParallelChannelDrawing,
  PitchforkDrawing,
  PitchforkVariant,
  PriceDateRangeDrawing,
  PriceRangeDrawing,
  RayDrawing,
  RectangleDrawing,
  ShortPositionDrawing,
  StrokeStyle,
  TextDrawing,
  TrendlineDrawing,
  VerticalLineDrawing,
} from "./types.js";
import type { BrushDrawing } from "./types.js";
import { asDrawingId, asPaneId, DEFAULT_ICON_GLYPHS, MAIN_PANE_ID } from "./types.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseAnchor(raw: unknown): DrawingAnchor | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const time = parseFiniteNumber(raw.time);
  const price = parseFiniteNumber(raw.price);
  if (time === null || price === null) {
    return null;
  }
  const paneRaw = raw.paneId;
  const paneId: PaneId = typeof paneRaw === "string" && paneRaw.length > 0 ? asPaneId(paneRaw) : MAIN_PANE_ID;
  return Object.freeze({
    time: asTime(time),
    price: asPrice(price),
    paneId,
  });
}

function parseStroke(raw: unknown): DrawingStroke | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const color = parseFiniteNumber(raw.color);
  if (color === null) {
    return undefined;
  }
  const styleRaw = raw.style;
  const style: StrokeStyle | undefined =
    styleRaw === "solid" || styleRaw === "dashed" || styleRaw === "dotted" ? styleRaw : undefined;
  const result: { color: number; alpha?: number; width?: number; style?: StrokeStyle } = { color };
  const alpha = parseFiniteNumber(raw.alpha);
  if (alpha !== null) {
    result.alpha = alpha;
  }
  const width = parseFiniteNumber(raw.width);
  if (width !== null) {
    result.width = width;
  }
  if (style !== undefined) {
    result.style = style;
  }
  return Object.freeze(result);
}

function parseFill(raw: unknown): DrawingFill | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const color = parseFiniteNumber(raw.color);
  if (color === null) {
    return undefined;
  }
  const result: { color: number; alpha?: number } = { color };
  const alpha = parseFiniteNumber(raw.alpha);
  if (alpha !== null) {
    result.alpha = alpha;
  }
  return Object.freeze(result);
}

function parseText(raw: unknown): DrawingTextStyle | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const color = parseFiniteNumber(raw.color);
  if (color === null) {
    return undefined;
  }
  const weightRaw = raw.weight;
  const weight: "normal" | "bold" | undefined =
    weightRaw === "normal" || weightRaw === "bold" ? weightRaw : undefined;
  const result: { color: number; size?: number; weight?: "normal" | "bold" } = { color };
  const size = parseFiniteNumber(raw.size);
  if (size !== null) {
    result.size = size;
  }
  if (weight !== undefined) {
    result.weight = weight;
  }
  return Object.freeze(result);
}

function parseStyle(raw: unknown): DrawingStyle {
  if (!isPlainObject(raw)) {
    return Object.freeze({});
  }
  const stroke = parseStroke(raw.stroke);
  const fill = parseFill(raw.fill);
  const text = parseText(raw.text);
  const extendRaw = raw.extend;
  const extend: ExtendMode | undefined =
    extendRaw === "none" || extendRaw === "left" || extendRaw === "right" || extendRaw === "both"
      ? extendRaw
      : undefined;
  const result: {
    stroke?: DrawingStroke;
    fill?: DrawingFill;
    text?: DrawingTextStyle;
    extend?: ExtendMode;
  } = {};
  if (stroke !== undefined) {
    result.stroke = stroke;
  }
  if (fill !== undefined) {
    result.fill = fill;
  }
  if (text !== undefined) {
    result.text = text;
  }
  if (extend !== undefined) {
    result.extend = extend;
  }
  return Object.freeze(result);
}

function isJsonValue(v: unknown): v is JsonValue {
  if (v === null) {
    return true;
  }
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") {
    return true;
  }
  if (Array.isArray(v)) {
    return v.every(isJsonValue);
  }
  if (isPlainObject(v)) {
    return Object.values(v).every(isJsonValue);
  }
  return false;
}

function parseMeta(raw: unknown): Readonly<Record<string, JsonValue>> | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const out: Record<string, JsonValue> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (isJsonValue(v)) {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

interface ParsedCommon {
  readonly id: DrawingId;
  readonly style: DrawingStyle;
  readonly locked: boolean;
  readonly visible: boolean;
  readonly z: number;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

function parseCommon(raw: Record<string, unknown>): ParsedCommon | null {
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const z = parseFiniteNumber(raw.z) ?? 0;
  const meta = parseMeta(raw.meta);
  const result: {
    id: DrawingId;
    style: DrawingStyle;
    locked: boolean;
    visible: boolean;
    z: number;
    meta?: Readonly<Record<string, JsonValue>>;
  } = {
    id: asDrawingId(id),
    style: parseStyle(raw.style),
    locked: raw.locked === true,
    visible: raw.visible !== false,
    z,
  };
  if (meta !== undefined) {
    result.meta = meta;
  }
  return Object.freeze(result);
}

function parsePairAnchors(raw: unknown): readonly [DrawingAnchor, DrawingAnchor] | null {
  if (!Array.isArray(raw) || raw.length !== 2) {
    return null;
  }
  const a = parseAnchor(raw[0]);
  const b = parseAnchor(raw[1]);
  if (a === null || b === null) {
    return null;
  }
  return Object.freeze([a, b] as const);
}

function parseSingleAnchor(raw: unknown): readonly [DrawingAnchor] | null {
  if (!Array.isArray(raw) || raw.length !== 1) {
    return null;
  }
  const a = parseAnchor(raw[0]);
  if (a === null) {
    return null;
  }
  return Object.freeze([a] as const);
}

function parseTrendline(raw: Record<string, unknown>): TrendlineDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "trendline" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseHorizontal(raw: Record<string, unknown>): HorizontalLineDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseSingleAnchor(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "horizontalLine" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseVertical(raw: Record<string, unknown>): VerticalLineDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseSingleAnchor(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "verticalLine" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseRectangle(raw: Record<string, unknown>): RectangleDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "rectangle" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseFibLevel(raw: unknown): FibLevel | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const value = parseFiniteNumber(raw.value);
  if (value === null) {
    return null;
  }
  const result: { value: number; color?: number; alpha?: number; visible?: boolean } = { value };
  const color = parseFiniteNumber(raw.color);
  if (color !== null) {
    result.color = color;
  }
  const alpha = parseFiniteNumber(raw.alpha);
  if (alpha !== null) {
    result.alpha = alpha;
  }
  if (typeof raw.visible === "boolean") {
    result.visible = raw.visible;
  }
  return Object.freeze(result);
}

function parseFib(raw: Record<string, unknown>): FibRetracementDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const levelsRaw = raw.levels;
  if (!Array.isArray(levelsRaw)) {
    return null;
  }
  const levels: FibLevel[] = [];
  for (const l of levelsRaw) {
    const parsed = parseFibLevel(l);
    if (parsed !== null) {
      levels.push(parsed);
    }
  }
  return Object.freeze({
    ...c,
    kind: "fibRetracement" as const,
    anchors,
    levels: Object.freeze(levels),
    showPrices: raw.showPrices !== false,
    showPercents: raw.showPercents !== false,
    schemaVersion: 1 as const,
  });
}

function parseTripleAnchors(raw: unknown): readonly [DrawingAnchor, DrawingAnchor, DrawingAnchor] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const a = parseAnchor(raw[0]);
  const b = parseAnchor(raw[1]);
  const c = parseAnchor(raw[2]);
  if (a === null || b === null || c === null) {
    return null;
  }
  return Object.freeze([a, b, c] as const);
}

function parseRay(raw: Record<string, unknown>): RayDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "ray" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseExtendedLine(raw: Record<string, unknown>): ExtendedLineDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "extendedLine" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseHorizontalRay(raw: Record<string, unknown>): HorizontalRayDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseSingleAnchor(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const directionRaw = raw.direction;
  const direction: HorizontalRayDirection =
    directionRaw === "left" || directionRaw === "right" ? directionRaw : "right";
  return Object.freeze({
    ...c,
    kind: "horizontalRay" as const,
    anchors,
    direction,
    schemaVersion: 1 as const,
  });
}

function parseParallelChannel(raw: Record<string, unknown>): ParallelChannelDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseTripleAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "parallelChannel" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

// ─── Phase 13 Cycle B.2 — position / text / callout / arrow / range parsers ──

function parseDisplayMode(raw: unknown): DisplayMode {
  return raw === "rr" || raw === "percent" || raw === "price" || raw === "ticks" ? raw : "rr";
}

function parsePositiveFiniteNumber(raw: unknown): number | null {
  const n = parseFiniteNumber(raw);
  return n !== null && n > 0 ? n : null;
}

function parsePositionLike(
  raw: Record<string, unknown>,
  kind: "longPosition" | "shortPosition",
): LongPositionDrawing | ShortPositionDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseTripleAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const endTime = parseFiniteNumber(raw.endTime);
  if (endTime === null) {
    return null;
  }
  if (endTime <= Number(anchors[0].time)) {
    return null;
  }
  // qty / tickSize / displayMode are tolerantly normalized.
  const qty = parsePositiveFiniteNumber(raw.qty) ?? 1;
  const tickSize = parsePositiveFiniteNumber(raw.tickSize);
  const displayMode = parseDisplayMode(raw.displayMode);
  const base = {
    ...c,
    anchors,
    endTime: asTime(endTime),
    qty,
    displayMode,
    schemaVersion: 1 as const,
  };
  const withTick = tickSize === null ? base : { ...base, tickSize };
  if (kind === "longPosition") {
    return Object.freeze({ ...withTick, kind: "longPosition" as const });
  }
  return Object.freeze({ ...withTick, kind: "shortPosition" as const });
}

function parseLongPosition(raw: Record<string, unknown>): LongPositionDrawing | null {
  const result = parsePositionLike(raw, "longPosition");
  return result !== null && result.kind === "longPosition" ? result : null;
}

function parseShortPosition(raw: Record<string, unknown>): ShortPositionDrawing | null {
  const result = parsePositionLike(raw, "shortPosition");
  return result !== null && result.kind === "shortPosition" ? result : null;
}

function parseTextDrawing(raw: Record<string, unknown>): TextDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseSingleAnchor(raw.anchors);
  if (anchors === null) {
    return null;
  }
  if (typeof raw.text !== "string") {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "text" as const,
    anchors,
    text: raw.text,
    schemaVersion: 1 as const,
  });
}

function parseCallout(raw: Record<string, unknown>): CalloutDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  if (typeof raw.text !== "string") {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "callout" as const,
    anchors,
    text: raw.text,
    schemaVersion: 1 as const,
  });
}

function parseArrow(raw: Record<string, unknown>): ArrowDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "arrow" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseDateRange(raw: Record<string, unknown>): DateRangeDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "dateRange" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parsePriceRange(raw: Record<string, unknown>): PriceRangeDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "priceRange" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parsePriceDateRange(raw: Record<string, unknown>): PriceDateRangeDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "priceDateRange" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

// ─── Phase 13 Cycle C.1 — exotic geometry parsers ──────────────────────────

function parsePitchforkVariant(raw: unknown): PitchforkVariant {
  return raw === "schiff" || raw === "modifiedSchiff" ? raw : "andrews";
}

function parsePitchfork(raw: Record<string, unknown>): PitchforkDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseTripleAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "pitchfork" as const,
    anchors,
    variant: parsePitchforkVariant(raw.variant),
    schemaVersion: 1 as const,
  });
}

function parseGannFan(raw: Record<string, unknown>): GannFanDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "gannFan" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

function parseEllipse(raw: Record<string, unknown>): EllipseDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "ellipse" as const,
    anchors,
    schemaVersion: 1 as const,
  });
}

// ─── Phase 13 Cycle C.2 — fib variant parsers ──────────────────────────────

function parseFibLevels(raw: unknown): readonly FibLevel[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const levels: FibLevel[] = [];
  for (const l of raw) {
    const parsed = parseFibLevel(l);
    if (parsed !== null) {
      levels.push(parsed);
    }
  }
  return Object.freeze(levels);
}

function parseFibExtension(raw: Record<string, unknown>): FibExtensionDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseTripleAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const levels = parseFibLevels(raw.levels);
  if (levels === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "fibExtension" as const,
    anchors,
    levels,
    showPrices: raw.showPrices !== false,
    showPercents: raw.showPercents !== false,
    schemaVersion: 1 as const,
  });
}

function parseFibTimeZones(raw: Record<string, unknown>): FibTimeZonesDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseSingleAnchor(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const offsetsRaw = raw.offsets;
  if (!Array.isArray(offsetsRaw)) {
    return null;
  }
  const offsets: number[] = [];
  for (const o of offsetsRaw) {
    if (typeof o === "number" && Number.isFinite(o) && Number.isInteger(o) && o > 0) {
      offsets.push(o);
    }
  }
  return Object.freeze({
    ...c,
    kind: "fibTimeZones" as const,
    anchors,
    offsets: Object.freeze(offsets),
    schemaVersion: 1 as const,
  });
}

function parseFibFan(raw: Record<string, unknown>): FibFanDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const levels = parseFibLevels(raw.levels);
  if (levels === null) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "fibFan" as const,
    anchors,
    levels,
    schemaVersion: 1 as const,
  });
}

function parseFibArcs(raw: Record<string, unknown>): FibArcsDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const levels = parseFibLevels(raw.levels);
  if (levels === null) {
    return null;
  }
  // Cycle C.3 — opt-in ring labels. Default false to preserve C.2 behavior.
  const showRingLabels = raw.showRingLabels === true;
  return Object.freeze({
    ...c,
    kind: "fibArcs" as const,
    anchors,
    levels,
    showRingLabels,
    schemaVersion: 1 as const,
  });
}

// ─── Phase 13 Cycle C.3 — brush + icon parsers ─────────────────────────────

function parsePointArray(raw: unknown): readonly DrawingAnchor[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: DrawingAnchor[] = [];
  for (const r of raw) {
    const a = parseAnchor(r);
    if (a === null) {
      return null;
    }
    out.push(a);
  }
  return Object.freeze(out);
}

function parseBrush(raw: Record<string, unknown>): BrushDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parsePairAnchors(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const points = parsePointArray(raw.points);
  if (points === null || points.length < 2) {
    return null;
  }
  return Object.freeze({
    ...c,
    kind: "brush" as const,
    anchors,
    points,
    schemaVersion: 1 as const,
  });
}

const ICON_GLYPH_SET: ReadonlySet<string> = new Set<string>(DEFAULT_ICON_GLYPHS);

function parseIconGlyph(raw: unknown): IconGlyph | null {
  if (typeof raw !== "string" || !ICON_GLYPH_SET.has(raw)) {
    return null;
  }
  return raw as IconGlyph;
}

function parseIcon(raw: Record<string, unknown>): IconDrawing | null {
  const c = parseCommon(raw);
  if (c === null) {
    return null;
  }
  const anchors = parseSingleAnchor(raw.anchors);
  if (anchors === null) {
    return null;
  }
  const glyph = parseIconGlyph(raw.glyph);
  if (glyph === null) {
    return null;
  }
  const size = parsePositiveFiniteNumber(raw.size);
  const tint = parseFiniteNumber(raw.tint);
  const base = {
    ...c,
    kind: "icon" as const,
    anchors,
    glyph,
    schemaVersion: 1 as const,
  };
  const withSize = size === null ? base : { ...base, size };
  const withTint = tint === null ? withSize : { ...withSize, tint };
  return Object.freeze(withTint);
}

const PARSERS: Readonly<Record<DrawingKind, (raw: Record<string, unknown>) => Drawing | null>> = {
  trendline: parseTrendline,
  horizontalLine: parseHorizontal,
  verticalLine: parseVertical,
  rectangle: parseRectangle,
  fibRetracement: parseFib,
  ray: parseRay,
  extendedLine: parseExtendedLine,
  horizontalRay: parseHorizontalRay,
  parallelChannel: parseParallelChannel,
  longPosition: parseLongPosition,
  shortPosition: parseShortPosition,
  text: parseTextDrawing,
  callout: parseCallout,
  arrow: parseArrow,
  dateRange: parseDateRange,
  priceRange: parsePriceRange,
  priceDateRange: parsePriceDateRange,
  pitchfork: parsePitchfork,
  gannFan: parseGannFan,
  ellipse: parseEllipse,
  fibExtension: parseFibExtension,
  fibTimeZones: parseFibTimeZones,
  fibFan: parseFibFan,
  fibArcs: parseFibArcs,
  brush: parseBrush,
  icon: parseIcon,
};

const KNOWN_KINDS: ReadonlySet<DrawingKind> = new Set([
  "trendline",
  "horizontalLine",
  "verticalLine",
  "rectangle",
  "fibRetracement",
  "ray",
  "extendedLine",
  "horizontalRay",
  "parallelChannel",
  "longPosition",
  "shortPosition",
  "text",
  "callout",
  "arrow",
  "dateRange",
  "priceRange",
  "priceDateRange",
  "pitchfork",
  "gannFan",
  "ellipse",
  "fibExtension",
  "fibTimeZones",
  "fibFan",
  "fibArcs",
  "brush",
  "icon",
]);

function isKnownKind(s: string): s is DrawingKind {
  return KNOWN_KINDS.has(s as DrawingKind);
}

export function parseDrawing(raw: unknown): Drawing | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !isKnownKind(kind)) {
    return null;
  }
  return PARSERS[kind](raw);
}

export interface ParseSnapshotResult {
  readonly snapshot: DrawingsSnapshot;
  readonly droppedCount: number;
  readonly droppedKinds: readonly string[];
  /**
   * Set when the input had a numeric `schemaVersion` other than 1; lets
   * callers log a "unsupported schemaVersion" warning instead of silently
   * yielding an empty snapshot. `null` for valid or unrecognizable inputs.
   */
  readonly unsupportedSchemaVersion: number | null;
}

function emptyResult(unsupportedSchemaVersion: number | null): ParseSnapshotResult {
  return Object.freeze({
    snapshot: Object.freeze({ schemaVersion: 1 as const, drawings: Object.freeze([] as readonly Drawing[]) }),
    droppedCount: 0,
    droppedKinds: Object.freeze([]),
    unsupportedSchemaVersion,
  });
}

export function parseSnapshot(raw: unknown): ParseSnapshotResult {
  if (!isPlainObject(raw) || !Array.isArray(raw.drawings)) {
    return emptyResult(null);
  }
  if (raw.schemaVersion !== 1) {
    const sv = typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : null;
    return emptyResult(sv);
  }
  const out: Drawing[] = [];
  let dropped = 0;
  const droppedKinds: string[] = [];
  for (const item of raw.drawings) {
    if (isPlainObject(item)) {
      const k = item.kind;
      if (typeof k === "string" && !isKnownKind(k)) {
        dropped += 1;
        droppedKinds.push(k);
        continue;
      }
    }
    const parsed = parseDrawing(item);
    if (parsed !== null) {
      out.push(parsed);
    } else {
      dropped += 1;
      const itemKind = isPlainObject(item) && typeof item.kind === "string" ? item.kind : "<invalid>";
      droppedKinds.push(itemKind);
    }
  }
  return Object.freeze({
    snapshot: Object.freeze({ schemaVersion: 1 as const, drawings: Object.freeze(out) }),
    droppedCount: dropped,
    droppedKinds: Object.freeze(droppedKinds),
    unsupportedSchemaVersion: null,
  });
}
