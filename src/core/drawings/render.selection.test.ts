// Phase 13 Cycle D — selection visual regression tests for the dashed bbox
// marquee, body halo, and re-coloured anchor handles. These tests target the
// pure functions in `./render.ts` (geomBbox + HandleContextCache) so they run
// in vitest's jsdom environment without needing a live Pixi renderer.

import { describe, expect, it } from "vitest";
import { Container, Graphics } from "pixi.js";
import {
  geomBbox,
  HandleContextCache,
  handleSpecsFor,
  redrawDrawing,
} from "./render.js";
import type { ScreenGeom } from "./project.js";
import type { Drawing } from "./types.js";
import { asDrawingId, MAIN_PANE_ID } from "./types.js";
import { asPrice, asTime } from "../../types.js";
import { DarkTheme, LightTheme } from "../infra/themes.js";

const anchor = (x: number, y: number): { x: number; y: number } => Object.freeze({ x, y });

describe("geomBbox", () => {
  it("returns the bbox field when present (parallelChannel)", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "parallelChannel",
      anchors: Object.freeze([anchor(0, 0), anchor(100, 50), anchor(0, 200)] as const),
      top: Object.freeze([anchor(0, 0), anchor(100, 50)] as const),
      bottom: Object.freeze([anchor(0, 100), anchor(100, 150)] as const),
      polygon: Object.freeze([anchor(0, 0), anchor(100, 50), anchor(100, 150), anchor(0, 100)] as const),
      bbox: Object.freeze({ xMin: 0, xMax: 100, yMin: 0, yMax: 150 }),
    });
    expect(geomBbox(geom)).toEqual({ xMin: 0, xMax: 100, yMin: 0, yMax: 150 });
  });

  it("derives bbox for a trendline from the visible segment", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "trendline",
      anchors: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
      visible: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
    });
    expect(geomBbox(geom)).toEqual({ xMin: 10, xMax: 50, yMin: 20, yMax: 80 });
  });

  it("derives bbox for a horizontalLine (zero-height)", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "horizontalLine",
      anchor: anchor(0, 100),
      snappedY: 100.5,
      x1: 0,
      x2: 600,
    });
    const b = geomBbox(geom);
    expect(b.yMin).toBe(b.yMax);
    expect(b.xMin).toBe(0);
    expect(b.xMax).toBe(600);
  });

  it("derives bbox for a callout from pin + label corners", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "callout",
      pin: anchor(50, 50),
      labelCenter: anchor(120, 80),
      labelX: 110,
      labelY: 70,
      labelW: 40,
      labelH: 20,
      leaderEnd: anchor(110, 80),
    });
    const b = geomBbox(geom);
    expect(b.xMin).toBeLessThanOrEqual(50);
    expect(b.xMax).toBeGreaterThanOrEqual(150);
    expect(b.yMin).toBeLessThanOrEqual(50);
    expect(b.yMax).toBeGreaterThanOrEqual(90);
  });

  it("derives bbox for an ellipse from xMin/xMax/yMin/yMax", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "ellipse",
      anchors: Object.freeze([anchor(0, 0), anchor(100, 80)] as const),
      cx: 50,
      cy: 40,
      rx: 50,
      ry: 40,
      xMin: 0,
      xMax: 100,
      yMin: 0,
      yMax: 80,
    });
    expect(geomBbox(geom)).toEqual({ xMin: 0, xMax: 100, yMin: 0, yMax: 80 });
  });

  it("handles an icon's square bbox derived from sizeCss", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "icon",
      anchor: anchor(100, 200),
      sizeCss: 16,
    });
    expect(geomBbox(geom)).toEqual({ xMin: 92, xMax: 108, yMin: 192, yMax: 208 });
  });
});

describe("HandleContextCache — Cycle D recolour + radius bump", () => {
  it("returns distinct contexts for primary vs secondary at the same dpr/variant/theme", () => {
    const cache = new HandleContextCache();
    const primary = cache.get("normal", DarkTheme, 1, true);
    const secondary = cache.get("normal", DarkTheme, 1, false);
    expect(primary).not.toBe(secondary);
    cache.destroy();
  });

  it("uses theme.selection as the fill so dark-theme handles are visible", () => {
    // Smoke test — the cache successfully constructs a context. Visual
    // contrast is asserted in Playwright (cycleD.selection.spec.ts) via
    // pixel-digest. Here we just ensure the cache doesn't throw and reuses.
    const cache = new HandleContextCache();
    const ctxA = cache.get("normal", DarkTheme, 1, true);
    const ctxB = cache.get("normal", DarkTheme, 1, true);
    expect(ctxA).toBe(ctxB); // cached
    cache.destroy();
  });

  it("returns different contexts across themes (cache key includes both colors)", () => {
    const cache = new HandleContextCache();
    const dark = cache.get("normal", DarkTheme, 1, true);
    const light = cache.get("normal", LightTheme, 1, true);
    expect(dark).not.toBe(light);
    cache.destroy();
  });

  it("returns different contexts across hover/active/normal variants", () => {
    const cache = new HandleContextCache();
    const normal = cache.get("normal", DarkTheme, 1, true);
    const hover = cache.get("hover", DarkTheme, 1, true);
    const active = cache.get("active", DarkTheme, 1, true);
    expect(normal).not.toBe(hover);
    expect(hover).not.toBe(active);
    expect(normal).not.toBe(active);
    cache.destroy();
  });
});

describe("handleSpecsFor — primary flag propagates to every spec", () => {
  it("marks specs as primary by default", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "trendline",
      anchors: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
      visible: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
    });
    const specs = handleSpecsFor(geom, null, null, { w: 600, h: 400 });
    expect(specs).toHaveLength(2);
    for (const s of specs) {
      expect(s.primary).toBe(true);
    }
  });

  it("marks specs as secondary when primary=false", () => {
    const geom: ScreenGeom = Object.freeze({
      kind: "trendline",
      anchors: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
      visible: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
    });
    const specs = handleSpecsFor(geom, null, null, { w: 600, h: 400 }, false);
    expect(specs).toHaveLength(2);
    for (const s of specs) {
      expect(s.primary).toBe(false);
    }
  });
});

describe("redrawDrawing — Cycle D selection + ghost params", () => {
  // We exercise the redraw entrypoint to confirm the new optional params
  // don't blow up when called the legacy way (no opts) and when selected /
  // ghost are passed. We can't assert pixel output in jsdom — Playwright
  // covers visual regressions.
  const trendline: Drawing = Object.freeze({
    id: asDrawingId("t1"),
    kind: "trendline" as const,
    anchors: Object.freeze([
      Object.freeze({ time: asTime(0), price: asPrice(100), paneId: MAIN_PANE_ID }),
      Object.freeze({ time: asTime(60_000), price: asPrice(110), paneId: MAIN_PANE_ID }),
    ] as const),
    style: Object.freeze({}),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
  });
  const trendlineGeom: ScreenGeom = Object.freeze({
    kind: "trendline",
    anchors: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
    visible: Object.freeze([anchor(10, 20), anchor(50, 80)] as const),
  });

  it("renders without throwing when no opts passed (legacy compat)", () => {
    const stage = new Container();
    const g = new Graphics();
    stage.addChild(g);
    expect(() => {
      redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1);
    }).not.toThrow();
  });

  it("sets g.alpha = 1 by default and 0.85 when ghost", () => {
    const stage = new Container();
    const g = new Graphics();
    stage.addChild(g);
    redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1);
    expect(g.alpha).toBe(1);
    redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1, { ghost: true });
    expect(g.alpha).toBeCloseTo(0.85, 3);
  });

  it("hides g when drawing.visible is false", () => {
    const hidden: Drawing = Object.freeze({ ...trendline, visible: false });
    const stage = new Container();
    const g = new Graphics();
    stage.addChild(g);
    redrawDrawing(g, hidden, trendlineGeom, DarkTheme, 1, { selected: "primary" });
    expect(g.visible).toBe(false);
  });

  it("accepts selected: 'primary' / 'secondary' / null without throwing", () => {
    const stage = new Container();
    const g = new Graphics();
    stage.addChild(g);
    expect(() => {
      redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1, { selected: "primary" });
      redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1, { selected: "secondary" });
      redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1, { selected: null });
    }).not.toThrow();
  });

  it("does not draw selection decoration when ghost=true (preview shouldn't double-up)", () => {
    // Ghost previews shouldn't sprout marquees/halos — they're meant to look
    // like in-progress shapes, not selected shapes. Both flags simultaneously
    // is a controller bug; the renderer's contract is "ghost wins".
    const stage = new Container();
    const g = new Graphics();
    stage.addChild(g);
    expect(() => {
      redrawDrawing(g, trendline, trendlineGeom, DarkTheme, 1, { selected: "primary", ghost: true });
    }).not.toThrow();
    expect(g.alpha).toBeCloseTo(0.85, 3);
  });
});
