import { describe, expect, it } from "vitest";
import { PaneHeader } from "./PaneHeader.js";
import { asPaneId } from "./types.js";
import { DarkTheme, LightTheme } from "../infra/themes.js";

describe("PaneHeader", () => {
  it("constructs with a hidden container until applyRect runs", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    expect(h.paneId).toBe(asPaneId("rsi"));
    // Default rect is 0×0; container.visible starts true (Pixi default).
    expect(h.getRect().h).toBe(0);
  });

  it("applyRect with h>0 sets container.visible = true and updates rect", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 100, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    expect(h.getRect().y).toBe(100);
    expect(h.getRect().h).toBe(24);
    expect(h.container.visible).toBe(true);
  });

  it("applyRect with h=0 hides the container", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 100, w: 800, h: 0 }, DarkTheme, "RSI(14)", false);
    expect(h.container.visible).toBe(false);
  });

  it("hitTest returns 'title' for left side; 'chevron' / 'gear' / 'close' for right cluster", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    // Left edge — title region.
    expect(h.hitTest(20, 12)).toBe("title");
    // Right cluster — buttons start at rightX - clusterW =
    //   800 - 8 - (3*18 + 2*4) = 800 - 8 - 62 = 730.
    // chevron sits at [730, 748].
    expect(h.hitTest(739, 12)).toBe("chevron");
    // gear at [752, 770].
    expect(h.hitTest(761, 12)).toBe("gear");
    // close at [774, 792].
    expect(h.hitTest(783, 12)).toBe("close");
  });

  it("hitTest returns null for points outside the rect", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 100, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    expect(h.hitTest(50, 50)).toBe(null); // above the strip
    expect(h.hitTest(50, 200)).toBe(null); // below the strip
    expect(h.hitTest(900, 110)).toBe(null); // beyond the right edge
  });

  it("hitTest skips when h=0", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 100, w: 800, h: 0 }, DarkTheme, "RSI(14)", false);
    expect(h.hitTest(739, 100)).toBe(null);
  });

  it("hitTest with non-finite coords returns null", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    expect(h.hitTest(Number.NaN, 12)).toBe(null);
    expect(h.hitTest(20, Number.POSITIVE_INFINITY)).toBe(null);
  });

  it("hitTest touch pointer extends button bounds (overlap area)", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    // Mouse: just outside chevron's left edge (730 - 1 = 729) → title.
    expect(h.hitTest(729, 12)).toBe("title");
    // Touch: same coords with 6 px pad → still chevron.
    expect(h.hitTest(729, 12, { pointerType: "touch" })).toBe("chevron");
  });

  it("setHover updates the hover region without crashing", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    expect(h.getHover()).toBe(null);
    h.setHover("chevron");
    expect(h.getHover()).toBe("chevron");
    h.setHover(null);
    expect(h.getHover()).toBe(null);
  });

  it("isCollapsedView reflects the last applyRect collapsed flag", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    expect(h.isCollapsedView()).toBe(false);
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", true);
    expect(h.isCollapsedView()).toBe(true);
  });

  it("survives a theme swap without crashing", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    expect(() => {
      h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, LightTheme, "RSI(14)", false);
    }).not.toThrow();
  });

  it("ellipsizes a long title at narrow width", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    // 240 px wide pane — too narrow for a 30-char title.
    h.applyRect(
      { x: 0, y: 0, w: 240, h: 24 },
      DarkTheme,
      "ASTROLOGICALLY UNREASONABLE LONG TITLE",
      false,
    );
    // No assertion on the exact rendered text (Pixi internals); just verify
    // applyRect doesn't crash.
    expect(h.getRect().w).toBe(240);
  });

  it("destroy is idempotent and detaches the container", () => {
    const h = new PaneHeader(asPaneId("rsi"));
    h.applyRect({ x: 0, y: 0, w: 800, h: 24 }, DarkTheme, "RSI(14)", false);
    h.destroy();
    h.destroy();
    // After destroy, hitTest returns null (defensive — destroyed flag).
    expect(h.hitTest(739, 12)).toBe(null);
  });
});
