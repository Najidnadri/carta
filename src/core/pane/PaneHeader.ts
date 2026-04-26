import { Container, Graphics, Text, type TextStyleOptions } from "pixi.js";
import type { Logger, Theme } from "../../types.js";
import type { PaneId } from "./types.js";
import type { PaneRect } from "./types.js";

/**
 * Phase 14 Cycle C — header strip rendered above each pane that opts in
 * via `addPane({ header: { title } })`. Lives in `Renderer.paneHeaderLayer`
 * (a sibling of `paneRoot`) so the strip stays visible even when the
 * pane's plot region collapses to 0 px.
 *
 * Scene-graph shape for one header:
 *
 *   container (translated to headerRect.x, headerRect.y)
 *     ├─ bg          (Graphics — fill + hover-button highlights)
 *     ├─ title       (Text — left-aligned, 8 px padding)
 *     ├─ chevron     (Graphics — toggles between ▾ and ▸ via clear+stroke)
 *     ├─ gear        (Graphics — settings icon)
 *     └─ closeButton (Graphics — × icon)
 *
 * The header is opt-in, off by default. The primary pane never has a
 * header — passing one warns at the chart-level entry point.
 */

/** Total header strip height in CSS px. Matches miniplan AC. */
export const PANE_HEADER_HEIGHT = 24;

/** Width of each right-cluster button (chevron / gear / ×). */
const BUTTON_SIZE = 18;
const BUTTON_GAP = 4;
const PADDING_X = 8;

/** Mouse hit-test extends the button bounds slightly (6 px overflow). */
const MOUSE_HIT_PAD = 0;
/** Touch hit-test extends bounds further to satisfy WCAG 2.5.5 (44 px floor). */
const TOUCH_HIT_PAD = 6;

/**
 * Right-cluster slot ids — order is `[chevron, gear, close]` reading
 * left-to-right (so the order in the array matches the visual order).
 */
export type PaneHeaderRegion = "title" | "chevron" | "gear" | "close";

export interface PaneHeaderHitOptions {
  readonly pointerType?: string | null;
}

export class PaneHeader {
  readonly paneId: PaneId;
  readonly container: Container;
  private readonly bg: Graphics;
  private readonly title: Text;
  private readonly chevron: Graphics;
  private readonly gear: Graphics;
  private readonly closeButton: Graphics;
  private rect: PaneRect = { x: 0, y: 0, w: 0, h: 0 };
  private hoverRegion: Exclude<PaneHeaderRegion, "title"> | null = null;
  private collapsed = false;
  private titleText = "";
  private destroyed = false;
  constructor(paneId: PaneId, _logger: Logger | null = null) {
    this.paneId = paneId;
    this.container = new Container({ label: `paneHeader:${String(paneId)}` });
    this.bg = new Graphics();
    const initialStyle: Partial<TextStyleOptions> = {
      fill: 0xffffff,
      fontFamily: "system-ui",
      fontSize: 11,
    };
    this.title = new Text({ text: "", style: initialStyle });
    this.title.eventMode = "none";
    this.chevron = new Graphics();
    this.gear = new Graphics();
    this.closeButton = new Graphics();
    this.container.addChild(this.bg, this.title, this.chevron, this.gear, this.closeButton);
  }

  /**
   * Apply layout + theme + state. Called from the chart's flush per
   * frame for every pane that has a header. `collapsed` decides which
   * chevron variant to draw (▾ when expanded, ▸ when collapsed).
   *
   * `rect.h === 0` means the header is suppressed for this frame
   * (e.g. the pane is hidden) — set `visible = false` and skip paints.
   */
  applyRect(
    rect: PaneRect,
    theme: Theme,
    titleText: string,
    collapsed: boolean,
  ): void {
    if (this.destroyed) {
      return;
    }
    this.rect = rect;
    this.collapsed = collapsed;
    this.container.position.set(rect.x, rect.y);
    if (rect.h <= 0 || rect.w <= 0) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;

    // Background fill — full strip width.
    const bg = this.bg;
    bg.clear().rect(0, 0, rect.w, rect.h).fill(theme.paneHeaderBg);

    // Hover rectangle for the active button (if any).
    if (this.hoverRegion !== null) {
      const btn = this.buttonRectForRegion(this.hoverRegion);
      bg.roundRect(btn.x, btn.y, btn.w, btn.h, 3).fill({
        color: theme.paneHeaderHoverBg,
        alpha: 1,
      });
    }

    // Title text.
    const ellipsized = ellipsize(titleText, rect.w);
    if (ellipsized !== this.titleText) {
      this.title.text = ellipsized;
      this.titleText = ellipsized;
    }
    const fontSize = Math.max(10, Math.min(13, theme.fontSize));
    this.title.style = {
      fill: theme.paneHeaderText,
      fontFamily: theme.fontFamily,
      fontSize,
    };
    // Avoid reading `this.title.height` here — Pixi measures the font by
    // calling into 2D canvas APIs which jsdom doesn't implement. Use the
    // declared font size as a deterministic vertical center reference; this
    // also keeps placement stable across theme swaps without re-measuring.
    this.title.position.set(PADDING_X, Math.round((rect.h - fontSize) / 2));

    // Chevron / gear / × — ordered left to right inside the right cluster.
    const chevronRect = this.buttonRectForRegion("chevron");
    const gearRect = this.buttonRectForRegion("gear");
    const closeRect = this.buttonRectForRegion("close");

    paintChevron(this.chevron, chevronRect, collapsed, theme.paneHeaderText);
    paintGear(this.gear, gearRect, theme.paneHeaderText);
    paintClose(this.closeButton, closeRect, theme.paneHeaderText);
  }

  /** Update hover state. Pass `null` when no button is hovered. */
  setHover(region: Exclude<PaneHeaderRegion, "title"> | null): void {
    if (this.destroyed) {
      return;
    }
    if (this.hoverRegion === region) {
      return;
    }
    this.hoverRegion = region;
  }

  getHover(): Exclude<PaneHeaderRegion, "title"> | null {
    return this.hoverRegion;
  }

  /**
   * Hit-test a pointer event at canvas-local coords (relative to the
   * canvas's top-left). Returns the region under the pointer, or `null`
   * if outside this header's bounds.
   */
  hitTest(localX: number, localY: number, options?: PaneHeaderHitOptions): PaneHeaderRegion | null {
    if (this.destroyed) {
      return null;
    }
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      return null;
    }
    if (this.rect.h <= 0 || this.rect.w <= 0) {
      return null;
    }
    const rx = localX - this.rect.x;
    const ry = localY - this.rect.y;
    if (ry < 0 || ry > this.rect.h || rx < 0 || rx > this.rect.w) {
      return null;
    }
    const pad = options?.pointerType === "touch" ? TOUCH_HIT_PAD : MOUSE_HIT_PAD;
    for (const region of ["chevron", "gear", "close"] as const) {
      const btn = this.buttonRectForRegion(region);
      if (
        rx >= btn.x - pad &&
        rx <= btn.x + btn.w + pad &&
        ry >= btn.y - pad &&
        ry <= btn.y + btn.h + pad
      ) {
        return region;
      }
    }
    return "title";
  }

  /** Read-only access for tests + the controller's drop-slot math. */
  getRect(): PaneRect {
    return this.rect;
  }

  isCollapsedView(): boolean {
    return this.collapsed;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.container.parent?.removeChild(this.container);
    this.container.destroy({ children: true });
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * Pixel rect of the requested button, relative to the header's origin
   * (i.e. before adding `rect.x` / `rect.y`). Returns `null` if there's
   * not enough horizontal room for the cluster (very narrow viewport).
   */
  private buttonRectForRegion(
    region: Exclude<PaneHeaderRegion, "title">,
  ): { x: number; y: number; w: number; h: number } {
    const order = { chevron: 0, gear: 1, close: 2 } as const;
    const idx = order[region];
    // Right-edge of the rightmost button.
    const rightX = this.rect.w - PADDING_X;
    // Cluster total width.
    const clusterW = BUTTON_SIZE * 3 + BUTTON_GAP * 2;
    const startX = rightX - clusterW;
    const x = startX + idx * (BUTTON_SIZE + BUTTON_GAP);
    const y = Math.round((this.rect.h - BUTTON_SIZE) / 2);
    return { x, y, w: BUTTON_SIZE, h: BUTTON_SIZE };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Trim a title with `…` so its rendered width fits the available strip. */
function ellipsize(input: string, maxStripW: number): string {
  if (typeof input !== "string" || input.length === 0) {
    return "";
  }
  // Reserve cluster + paddings + small breathing room.
  const buttonsW = BUTTON_SIZE * 3 + BUTTON_GAP * 2 + PADDING_X * 2 + 8;
  const titleAvailable = Math.max(0, maxStripW - buttonsW);
  // Approximate via average glyph width (6 px @ 11 px font); trim until it
  // fits. Cheap heuristic — better than no clamp.
  const approxGlyphW = 6;
  const maxChars = Math.max(0, Math.floor(titleAvailable / approxGlyphW));
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 1) {
    return "";
  }
  return `${input.slice(0, Math.max(1, maxChars - 1))}…`;
}

function paintChevron(
  g: Graphics,
  rect: { x: number; y: number; w: number; h: number },
  collapsed: boolean,
  color: number,
): void {
  g.clear();
  // Chevron geometry — 6 px wide, 4 px tall, centred in the button rect.
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  if (collapsed) {
    // Right-pointing chevron `▸` — apex on the right.
    g.moveTo(cx - 3, cy - 4)
      .lineTo(cx + 3, cy)
      .lineTo(cx - 3, cy + 4);
  } else {
    // Down-pointing chevron `▾` — apex on the bottom.
    g.moveTo(cx - 4, cy - 3)
      .lineTo(cx, cy + 3)
      .lineTo(cx + 4, cy - 3);
  }
  g.stroke({ width: 1.5, color, cap: "round", join: "round" });
}

function paintGear(
  g: Graphics,
  rect: { x: number; y: number; w: number; h: number },
  color: number,
): void {
  g.clear();
  // Simple gear silhouette — 6 spokes via an outer star + inner hole. Cheap
  // and reads as "settings" at 18 px square.
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const outerR = 6;
  const innerR = 3.5;
  const spokes = 6;
  const half = (Math.PI * 2) / (spokes * 2);
  const points: number[] = [];
  for (let i = 0; i < spokes * 2; i += 1) {
    const r = i % 2 === 0 ? outerR : outerR - 1.5;
    const angle = i * half;
    points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  }
  g.poly(points)
    .stroke({ width: 1, color });
  // Inner hole (open ring).
  g.circle(cx, cy, innerR).stroke({ width: 1, color });
}

function paintClose(
  g: Graphics,
  rect: { x: number; y: number; w: number; h: number },
  color: number,
): void {
  g.clear();
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  g.moveTo(cx - 4, cy - 4)
    .lineTo(cx + 4, cy + 4)
    .moveTo(cx + 4, cy - 4)
    .lineTo(cx - 4, cy + 4)
    .stroke({ width: 1.5, color, cap: "round" });
}
