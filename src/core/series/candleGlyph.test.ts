import { describe, it, expect, vi } from "vitest";
import { Graphics } from "pixi.js";
import { drawCandleGlyph, MIN_CANDLE_BODY_HEIGHT_PX } from "./candleGlyph.js";

interface StrokeCall {
  readonly color: number;
  readonly width: number;
  readonly pixelLine: boolean;
}

interface RectCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface FillCall {
  readonly color: number;
}

interface CapturedGraphics {
  readonly g: Graphics;
  readonly strokes: StrokeCall[];
  readonly rects: RectCall[];
  readonly fills: FillCall[];
}

function makeCapturing(): CapturedGraphics {
  const g = new Graphics();
  const strokes: StrokeCall[] = [];
  const rects: RectCall[] = [];
  const fills: FillCall[] = [];
  vi.spyOn(g, "stroke").mockImplementation((style): Graphics => {
    const s = style as { color: number; width: number; pixelLine?: boolean };
    strokes.push({
      color: s.color,
      width: s.width,
      pixelLine: s.pixelLine ?? false,
    });
    return g;
  });
  vi.spyOn(g, "rect").mockImplementation((x, y, w, h): Graphics => {
    rects.push({ x, y, w, h });
    return g;
  });
  vi.spyOn(g, "fill").mockImplementation((style): Graphics => {
    let color = Number.NaN;
    if (typeof style === "number") {
      color = style;
    } else if (typeof style === "object" && "color" in style) {
      color = Number((style as { color: unknown }).color);
    }
    fills.push({ color });
    return g;
  });
  return { g, strokes, rects, fills };
}

describe("drawCandleGlyph", () => {
  it("emits one wick stroke + one body rect+fill", () => {
    const cap = makeCapturing();
    drawCandleGlyph(cap.g, {
      x: 50,
      yOpen: 120,
      yClose: 100,
      yHigh: 80,
      yLow: 140,
      color: 0x00ff00,
      wickWidth: 1,
      half: 4,
    });
    expect(cap.strokes).toHaveLength(1);
    expect(cap.strokes[0]).toEqual({ color: 0x00ff00, width: 1, pixelLine: true });
    expect(cap.rects).toHaveLength(1);
    expect(cap.rects[0]).toEqual({ x: 46, y: 100, w: 8, h: 20 });
    expect(cap.fills).toHaveLength(1);
    expect(cap.fills[0]).toEqual({ color: 0x00ff00 });
    cap.g.destroy();
  });

  it("disables pixelLine when wickWidth > 1", () => {
    const cap = makeCapturing();
    drawCandleGlyph(cap.g, {
      x: 0,
      yOpen: 10,
      yClose: 20,
      yHigh: 0,
      yLow: 30,
      color: 0xffffff,
      wickWidth: 2,
      half: 3,
    });
    expect(cap.strokes[0]?.pixelLine).toBe(false);
    expect(cap.strokes[0]?.width).toBe(2);
    cap.g.destroy();
  });

  it("clamps body height to MIN_CANDLE_BODY_HEIGHT_PX when open == close", () => {
    const cap = makeCapturing();
    drawCandleGlyph(cap.g, {
      x: 10,
      yOpen: 100,
      yClose: 100,
      yHigh: 80,
      yLow: 120,
      color: 0x123456,
      wickWidth: 1,
      half: 2,
    });
    expect(cap.rects[0]?.h).toBe(MIN_CANDLE_BODY_HEIGHT_PX);
    cap.g.destroy();
  });

  it("positions body between min(yOpen, yClose) and max", () => {
    const cap = makeCapturing();
    drawCandleGlyph(cap.g, {
      x: 0,
      yOpen: 50,
      yClose: 200,
      yHigh: 20,
      yLow: 220,
      color: 0xff0000,
      wickWidth: 1,
      half: 1,
    });
    expect(cap.rects[0]?.y).toBe(50);
    expect(cap.rects[0]?.h).toBe(150);
    cap.g.destroy();
  });
});
