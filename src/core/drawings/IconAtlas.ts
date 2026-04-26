/**
 * Phase 13 Cycle C.3 — runtime-built sprite atlas for icon stamps.
 *
 * Procedural canvas → `TextureSource` (synchronous; no `Assets.load`). One
 * cell per glyph, single row, white silhouettes on transparent — `Sprite.tint`
 * colors them at render time. Sub-textures share the source so all icons
 * render in one batch.
 *
 * DPR strategy: rebuild the atlas (and reassign every sprite's texture) when
 * the active DPR bucket changes. The controller compares
 * `iconAtlas.dprBucket` against the current bucket lazily at icon render
 * time; the existing `'size'` invalidation already triggers a re-render on
 * DPR change, so no new event subscription is needed.
 */

import { CanvasSource, Rectangle, Texture, type TextureSource } from "pixi.js";
import { DEFAULT_ICON_GLYPHS, type IconGlyph } from "./types.js";

/** CSS-px size of a single atlas cell — matches the default `IconDrawing.size`. */
export const ICON_CELL_CSS_PX = 32;

export interface IconAtlas {
  /** Backing `TextureSource` (single canvas-backed source). */
  readonly source: TextureSource;
  /** One sub-texture per glyph, addressing the appropriate atlas cell. */
  readonly textures: ReadonlyMap<IconGlyph, Texture>;
  /** Backing-store cell size in pixels (= `ICON_CELL_CSS_PX * dprBucket`). */
  readonly cellPx: number;
  /** DPR bucket the atlas was built at — `1`, `1.5`, or `2`. */
  readonly dprBucket: number;
  destroy(): void;
}

type GlyphDrawer = (
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  cell: number,
) => void;

/**
 * Hand-coded silhouette drawers for the 10 default glyphs. Each operates on a
 * `cell × cell` square at offset `(ox, oy)`. White fill / stroke; alpha-only
 * silhouettes — the sprite's `tint` colors the result.
 */
const GLYPH_DRAWERS: Record<IconGlyph, GlyphDrawer> = {
  arrowUp: (ctx, ox, oy, cell) => {
    const cx = ox + cell / 2;
    const top = oy + cell * 0.18;
    const bottom = oy + cell * 0.82;
    const half = cell * 0.32;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx + half, oy + cell * 0.5);
    ctx.lineTo(cx + half * 0.45, oy + cell * 0.5);
    ctx.lineTo(cx + half * 0.45, bottom);
    ctx.lineTo(cx - half * 0.45, bottom);
    ctx.lineTo(cx - half * 0.45, oy + cell * 0.5);
    ctx.lineTo(cx - half, oy + cell * 0.5);
    ctx.closePath();
    ctx.fill();
  },
  arrowDown: (ctx, ox, oy, cell) => {
    const cx = ox + cell / 2;
    const top = oy + cell * 0.18;
    const bottom = oy + cell * 0.82;
    const half = cell * 0.32;
    ctx.beginPath();
    ctx.moveTo(cx, bottom);
    ctx.lineTo(cx + half, oy + cell * 0.5);
    ctx.lineTo(cx + half * 0.45, oy + cell * 0.5);
    ctx.lineTo(cx + half * 0.45, top);
    ctx.lineTo(cx - half * 0.45, top);
    ctx.lineTo(cx - half * 0.45, oy + cell * 0.5);
    ctx.lineTo(cx - half, oy + cell * 0.5);
    ctx.closePath();
    ctx.fill();
  },
  flag: (ctx, ox, oy, cell) => {
    const poleX = ox + cell * 0.32;
    const poleW = Math.max(2, cell * 0.07);
    ctx.fillRect(poleX, oy + cell * 0.15, poleW, cell * 0.7);
    // Pennant.
    ctx.beginPath();
    ctx.moveTo(poleX + poleW, oy + cell * 0.18);
    ctx.lineTo(ox + cell * 0.82, oy + cell * 0.32);
    ctx.lineTo(poleX + poleW, oy + cell * 0.5);
    ctx.closePath();
    ctx.fill();
  },
  target: (ctx, ox, oy, cell) => {
    const cx = ox + cell / 2;
    const cy = oy + cell / 2;
    const r = cell * 0.36;
    ctx.lineWidth = Math.max(2, cell * 0.06);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
  },
  cross: (ctx, ox, oy, cell) => {
    ctx.lineWidth = Math.max(3, cell * 0.12);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ox + cell * 0.25, oy + cell * 0.25);
    ctx.lineTo(ox + cell * 0.75, oy + cell * 0.75);
    ctx.moveTo(ox + cell * 0.75, oy + cell * 0.25);
    ctx.lineTo(ox + cell * 0.25, oy + cell * 0.75);
    ctx.stroke();
  },
  check: (ctx, ox, oy, cell) => {
    ctx.lineWidth = Math.max(3, cell * 0.12);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(ox + cell * 0.22, oy + cell * 0.55);
    ctx.lineTo(ox + cell * 0.42, oy + cell * 0.74);
    ctx.lineTo(ox + cell * 0.78, oy + cell * 0.3);
    ctx.stroke();
  },
  star: (ctx, ox, oy, cell) => {
    const cx = ox + cell / 2;
    const cy = oy + cell / 2;
    const outer = cell * 0.4;
    const inner = cell * 0.18;
    const points = 5;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fill();
  },
  exclaim: (ctx, ox, oy, cell) => {
    const cx = ox + cell / 2;
    const w = Math.max(2, cell * 0.16);
    const top = oy + cell * 0.16;
    const dotY = oy + cell * 0.78;
    ctx.fillRect(cx - w / 2, top, w, cell * 0.46);
    ctx.beginPath();
    ctx.arc(cx, dotY, w * 0.7, 0, Math.PI * 2);
    ctx.fill();
  },
  dollar: (ctx, ox, oy, cell) => {
    ctx.font = `bold ${String(Math.round(cell * 0.74))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("$", ox + cell / 2, oy + cell / 2 + 1);
  },
  comment: (ctx, ox, oy, cell) => {
    const x = ox + cell * 0.18;
    const y = oy + cell * 0.22;
    const w = cell * 0.64;
    const h = cell * 0.42;
    const r = cell * 0.08;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    // Tail.
    ctx.lineTo(x + w * 0.32, y + h);
    ctx.lineTo(x + w * 0.22, y + h + cell * 0.14);
    ctx.lineTo(x + w * 0.22, y + h);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  },
};

function clampDprBucket(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 1) {
    return 1;
  }
  if (dpr <= 1.5) {
    return 1.5;
  }
  return 2;
}

/**
 * Build the atlas at the given DPR bucket. Synchronous — completes before
 * returning. Idempotent in the sense that calling twice with the same
 * `dprBucket` produces independent (but equivalent) atlases; controllers
 * should `destroy()` the old one before swapping.
 */
export function buildIconAtlas(dpr: number): IconAtlas {
  const dprBucket = clampDprBucket(dpr);
  const cellPx = Math.round(ICON_CELL_CSS_PX * dprBucket);
  const cols = DEFAULT_ICON_GLYPHS.length;
  const canvas = document.createElement("canvas");
  canvas.width = cellPx * cols;
  canvas.height = cellPx;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // jsdom or sandboxed runtime without 2d support — bail with empty atlas.
    const source = new CanvasSource({ resource: canvas, scaleMode: "linear" });
    const textures = new Map<IconGlyph, Texture>();
    return {
      source,
      textures,
      cellPx,
      dprBucket,
      destroy(): void {
        source.destroy();
      },
    };
  }
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.imageSmoothingEnabled = true;
  for (let i = 0; i < cols; i++) {
    const glyph = DEFAULT_ICON_GLYPHS[i];
    if (glyph === undefined) {
      continue;
    }
    const drawer = GLYPH_DRAWERS[glyph];
    drawer(ctx, i * cellPx, 0, cellPx);
  }
  // Phase 13 Cycle D fix — `TextureSource` with a HTMLCanvasElement resource
  // does NOT trigger GPU upload in PixiJS v8. Use `CanvasSource` (which
  // wraps the canvas as a texture-uploadable resource) so the procedurally-
  // drawn glyph silhouettes actually show up on screen.
  const source = new CanvasSource({
    resource: canvas,
    scaleMode: "linear",
    width: canvas.width,
    height: canvas.height,
  });
  const textures = new Map<IconGlyph, Texture>();
  for (let i = 0; i < cols; i++) {
    const glyph = DEFAULT_ICON_GLYPHS[i];
    if (glyph === undefined) {
      continue;
    }
    const tex = new Texture({
      source,
      frame: new Rectangle(i * cellPx, 0, cellPx, cellPx),
    });
    textures.set(glyph, tex);
  }
  return {
    source,
    textures,
    cellPx,
    dprBucket,
    destroy(): void {
      for (const t of textures.values()) {
        t.destroy();
      }
      textures.clear();
      source.destroy();
    },
  };
}
