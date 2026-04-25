import { BitmapText, Graphics, GraphicsContext } from "pixi.js";
import type { PriceRange } from "./PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import {
  applyMarkerOffsetPx,
  resolveMarkerPrice,
  snapBack,
} from "./markerGeometry.js";
import {
  type DataRecord,
  type MarkerOverlayOptions,
  type MarkerPosition,
  type MarkerRecord,
  type MarkerShape,
  type OhlcRecord,
  type PointRecord,
  type Time,
} from "../types.js";

const DEFAULT_SIZE_PX = 12;
/** Bootstrap font used until the first render threads a theme through. */
const BOOTSTRAP_FONT_FAMILY = "Arial";
const BOOTSTRAP_FONT_SIZE_PX = 11;
const TEXT_GAP_PX = 2;

function isMarkerRecord(r: DataRecord): r is MarkerRecord {
  if ("value" in r || "open" in r) {
    return false;
  }
  return "shape" in r && "position" in r;
}

function isOhlcOrPointRecord(r: DataRecord): r is OhlcRecord | PointRecord {
  return "open" in r || "value" in r;
}

function buildShapeContexts(): Record<MarkerShape, GraphicsContext> {
  // Unit geometry: every shape fits in a 2×2 box centered at (0, 0), filled
  // white so per-marker `tint` applies cleanly. The marker caller scales
  // the Graphics to size (radius / half-side / half-height in CSS px).
  const circleCtx = new GraphicsContext().circle(0, 0, 1).fill(0xffffff);
  const squareCtx = new GraphicsContext().rect(-1, -1, 2, 2).fill(0xffffff);
  const arrowUpCtx = new GraphicsContext()
    .poly([0, -1, -0.866, 0.5, 0.866, 0.5])
    .fill(0xffffff);
  const arrowDownCtx = new GraphicsContext()
    .poly([0, 1, -0.866, -0.5, 0.866, -0.5])
    .fill(0xffffff);
  return {
    circle: circleCtx,
    square: squareCtx,
    arrowUp: arrowUpCtx,
    arrowDown: arrowDownCtx,
  };
}

interface PooledMarker {
  readonly graphics: Graphics;
  readonly text: BitmapText;
}

/**
 * Marker-kind overlay. Renders shape glyphs (circle / square / arrowUp /
 * arrowDown) from a `marker` channel anchored to the bars of a separate
 * `ohlc` or `point` channel via `priceReference`. Markers never influence
 * auto-scale — `priceRangeInWindow` always returns `null`.
 *
 * `priceReference.channel` names a **channel id**, not a series instance.
 * When the primary view is `HeikinAshiSeries`, markers still resolve their
 * y against the raw OHLC records in the referenced channel (HA bars are
 * series-local and are not re-cached under a separate channel). Hosts
 * that want HA-anchored markers should register a dedicated HA channel
 * and point `priceReference.channel` at it.
 *
 * Note on multi-markers-per-bar: `IntervalCache` keys records by `time`,
 * so supplying multiple markers with identical `time` keeps only the last
 * — the overlay renders cleanly but only the last marker is visible.
 * Hosts that need several glyphs on one bar should dither `time` by ±1 ms
 * or split them across separate marker channels.
 *
 * Implementation:
 * - 4 pre-built unit `GraphicsContext`s (one per shape) swapped per marker
 *   via `graphics.context = sharedCtx`. Per-marker colour is applied via
 *   `graphics.tint`; size via `graphics.scale`. No per-frame geometry
 *   rebuild.
 * - Dedicated pool that *hides* Graphics on release rather than clearing
 *   them — clearing would destroy the shared context's geometry.
 * - Optional `record.text` rendered via `BitmapText` with PixiJS v8's
 *   dynamic font atlas (no shipped fonts). Text stays hidden when the
 *   marker has no `text`.
 * - Reference records are pulled from `dataStore` on every render; missing
 *   anchors are silently skipped and counted via `lastSkippedCount()`.
 */
export class MarkerOverlay extends Series {
  private opts: MarkerOverlayOptions;
  private readonly shapeCtxs: Record<MarkerShape, GraphicsContext>;
  private readonly free: PooledMarker[] = [];
  private readonly inUse: PooledMarker[] = [];
  private lastSkipCount = 0;
  private lastFontFamily = BOOTSTRAP_FONT_FAMILY;
  private lastFontSize = BOOTSTRAP_FONT_SIZE_PX;
  private destroyed = false;

  constructor(options: MarkerOverlayOptions) {
    super(options.channel, "marker", `MarkerOverlay(${options.channel})`);
    this.opts = options;
    this.shapeCtxs = buildShapeContexts();
  }

  applyOptions(patch: Partial<MarkerOverlayOptions>): void {
    const merged = this.mergeOptions(this.opts, patch);
    // `priceReference.channel` is the y-anchor channel; rebinding it after
    // construction would silently break the overlay's data lookup. Pin it
    // alongside `channel`, but allow `field` (high/low/close/value) to flip.
    if (patch.priceReference !== undefined) {
      this.opts = {
        ...merged,
        priceReference: {
          ...this.opts.priceReference,
          ...patch.priceReference,
          channel: this.opts.priceReference.channel,
        },
      };
    } else {
      this.opts = merged;
    }
    this.requestInvalidate();
  }

  /** Markers never contribute to auto-scale. */
  priceRangeInWindow(_startTime: Time, _endTime: Time): PriceRange | null {
    return null;
  }

  render(ctx: SeriesRenderContext): void {
    // Phase 10 — propagate theme typography to the BitmapText pool. Constructor
    // option `textFontFamily` / `textFontSize` (when set) wins over the theme
    // for parity with the v1 series-options precedence contract.
    const effectiveFontFamily = this.opts.textFontFamily ?? ctx.theme.fontFamily;
    const effectiveFontSize = this.opts.textFontSize ?? ctx.theme.fontSize;
    this.applyFontIfChanged(effectiveFontFamily, effectiveFontSize);

    this.releaseAll();
    const iv = Number(ctx.intervalDuration);
    if (!Number.isFinite(iv) || iv <= 0) {
      return;
    }
    const start = Number(ctx.startTime);
    const end = Number(ctx.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return;
    }
    // Read the reference channel's records once per frame. We use the padded
    // window so partial-edge markers still resolve to the nearest bar.
    const refChannel = this.opts.priceReference.channel;
    const refKind = ctx.dataStore.getChannel(refChannel)?.kind;
    if (refKind !== "ohlc" && refKind !== "point") {
      // Reference channel missing or wrong kind — render nothing.
      return;
    }
    const refRecords: readonly (OhlcRecord | PointRecord)[] = ctx.dataStore
      .recordsInRange(refChannel, iv, start - iv, end + iv)
      .filter(isOhlcOrPointRecord);

    const markers: readonly MarkerRecord[] = ctx.dataStore
      .recordsInRange(this.channel, iv, start - iv, end + iv)
      .filter(isMarkerRecord);

    if (markers.length === 0) {
      this.lastSkipCount = 0;
      return;
    }

    const defaultColor = this.opts.defaultColor ?? ctx.theme.line;
    const size = this.opts.defaultSize ?? DEFAULT_SIZE_PX;
    const field = this.opts.priceReference.field;

    let skipCount = 0;
    for (const m of markers) {
      const t = Number(m.time);
      if (!Number.isFinite(t)) {
        skipCount++;
        continue;
      }
      const anchorIdx = snapBack(refRecords, t);
      if (anchorIdx === -1) {
        skipCount++;
        continue;
      }
      const refRecord = refRecords[anchorIdx];
      if (refRecord === undefined) {
        skipCount++;
        continue;
      }
      const price = resolveMarkerPrice(m.position, refRecord, field);
      if (price === null) {
        skipCount++;
        continue;
      }
      // Snap x to the marker's own time (not the reference record's), so
      // the glyph sits over the bar at `m.time` even if that bar is the
      // missing one we snap-backed for the Y anchor. This matches
      // TradingView's convention for out-of-range markers.
      const x = Number(ctx.timeScale.timeToPixel(m.time));
      const baseY = Number(ctx.priceScale.valueToPixel(price));
      if (!Number.isFinite(x) || !Number.isFinite(baseY)) {
        skipCount++;
        continue;
      }
      const y = applyMarkerOffsetPx(m.position, baseY, size);
      const pooled = this.acquire();
      const shapeCtx = this.shapeCtxs[m.shape];
      pooled.graphics.context = shapeCtx;
      pooled.graphics.tint = m.color ?? defaultColor;
      pooled.graphics.scale.set(size, size);
      pooled.graphics.position.set(x, y);
      pooled.graphics.visible = true;

      if (typeof m.text === "string" && m.text.length > 0) {
        pooled.text.text = m.text;
        pooled.text.tint = m.color ?? defaultColor;
        pooled.text.visible = true;
        this.positionLabel(pooled.text, m.position, x, y, size);
      } else {
        pooled.text.visible = false;
      }
    }
    this.lastSkipCount = skipCount;
  }

  private positionLabel(
    text: BitmapText,
    position: MarkerPosition,
    x: number,
    y: number,
    size: number,
  ): void {
    // Anchor the text just outside the shape along its primary axis so
    // the glyph stays visible between the reference bar and the label.
    text.anchor.set(0.5, 0.5);
    const halfShape = size;
    if (position === "above") {
      text.position.set(x, y - halfShape - TEXT_GAP_PX);
    } else if (position === "below") {
      text.position.set(x, y + halfShape + TEXT_GAP_PX);
    } else {
      text.position.set(x + halfShape + TEXT_GAP_PX, y);
    }
  }

  private acquire(): PooledMarker {
    const popped = this.free.pop();
    if (popped !== undefined) {
      popped.graphics.visible = true;
      this.inUse.push(popped);
      return popped;
    }
    const graphics = new Graphics();
    const text = new BitmapText({
      text: "",
      style: {
        fontFamily: this.lastFontFamily,
        fontSize: this.lastFontSize,
        fill: 0xffffff,
      },
    });
    text.visible = false;
    this.container.addChild(graphics);
    this.container.addChild(text);
    const pooled: PooledMarker = { graphics, text };
    this.inUse.push(pooled);
    return pooled;
  }

  /**
   * Phase 10 — when the theme's effective fontFamily / fontSize change, mutate
   * every existing pooled label's style in place. New labels acquired after
   * this point pick up the new font from `lastFontFamily` / `lastFontSize`.
   */
  private applyFontIfChanged(fontFamily: string, fontSize: number): void {
    if (fontFamily === this.lastFontFamily && fontSize === this.lastFontSize) {
      return;
    }
    for (const p of this.inUse) {
      p.text.style.fontFamily = fontFamily;
      p.text.style.fontSize = fontSize;
    }
    for (const p of this.free) {
      p.text.style.fontFamily = fontFamily;
      p.text.style.fontSize = fontSize;
    }
    this.lastFontFamily = fontFamily;
    this.lastFontSize = fontSize;
  }

  private releaseAll(): void {
    for (const p of this.inUse) {
      // Do NOT call graphics.clear() — it would wipe the shared
      // GraphicsContext that other markers reuse.
      p.graphics.visible = false;
      p.text.visible = false;
      this.free.push(p);
    }
    this.inUse.length = 0;
  }

  /** Dev / test introspection: markers currently rendered this frame. */
  activePoolSize(): number {
    return this.inUse.length;
  }

  /** Dev / test introspection: high-water mark (free + in-use). */
  totalPoolSize(): number {
    return this.free.length + this.inUse.length;
  }

  /** Dev / test introspection: number of markers skipped in the last render. */
  lastSkippedCount(): number {
    return this.lastSkipCount;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const p of this.inUse) {
      p.graphics.destroy();
      p.text.destroy();
    }
    for (const p of this.free) {
      p.graphics.destroy();
      p.text.destroy();
    }
    this.inUse.length = 0;
    this.free.length = 0;
    this.shapeCtxs.circle.destroy();
    this.shapeCtxs.square.destroy();
    this.shapeCtxs.arrowUp.destroy();
    this.shapeCtxs.arrowDown.destroy();
    super.destroy();
  }
}

// Internal exports for whitebox tests.
export const __internals__ = {
  buildShapeContexts,
  isMarkerRecord,
  isOhlcOrPointRecord,
};
