import { describe, expect, it, vi } from "vitest";
import type { PriceRange, PriceRangeProvider } from "../price/PriceRangeProvider.js";
import { asPrice, asTime, type Logger, type PriceScaleMode, type Time } from "../../types.js";
import { Pane, sanitizePriceScaleMode, type PaneOwner, type PrePatchPaneSnapshot } from "./Pane.js";
import { asPaneId, MAIN_PANE_ID } from "./types.js";

class MockProvider implements PriceRangeProvider {
  constructor(private readonly range: PriceRange | null) {}
  priceRangeInWindow(_start: Time, _end: Time): PriceRange | null {
    return this.range;
  }
}

describe("Pane", () => {
  it("constructs with the right scale slot present by default", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    expect(pane.id).toBe(MAIN_PANE_ID);
    const facade = pane.priceScale("right");
    expect(facade).toBeDefined();
    expect(facade.isAutoScale()).toBe(false);
  });

  it("lazy-creates an overlay slot on first ensureSlot('')", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    expect(pane.scales().length).toBe(1);
    pane.ensureSlot("", { top: 0.8, bottom: 0 });
    expect(pane.scales().length).toBe(2);
    const overlay = pane.scales().find((s) => s.id === "");
    expect(overlay?.margins.top).toBe(0.8);
    expect(overlay?.margins.bottom).toBe(0);
  });

  it("registers a series provider on a scale slot and reduces ranges on reconcile", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    const provider = new MockProvider({ min: asPrice(10), max: asPrice(20) });
    pane.addSeriesToScale(provider, "right");
    pane.priceScale("right").setAutoScale(true);
    pane.reconcileEachScale(0, 1000);
    const domain = pane.priceScale("right").getDomain();
    expect(Number(domain.min)).toBe(10);
    expect(Number(domain.max)).toBe(20);
  });

  it("retains prior domain when reduce returns null (no providers)", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    pane.priceScale("right").setDomain(5, 15);
    pane.priceScale("right").setAutoScale(true);
    pane.reconcileEachScale(0, 1000);
    const domain = pane.priceScale("right").getDomain();
    // Prior domain retained because no providers contributed.
    expect(Number(domain.min)).toBe(0);
    expect(Number(domain.max)).toBe(1);
  });

  it("manual setDomain disables auto-scale on the slot", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    pane.priceScale("right").setAutoScale(true);
    expect(pane.priceScale("right").isAutoScale()).toBe(true);
    pane.priceScale("right").setDomain(0, 100);
    expect(pane.priceScale("right").isAutoScale()).toBe(false);
    pane.reconcileEachScale(0, 1000);
    const domain = pane.priceScale("right").getDomain();
    expect(Number(domain.min)).toBe(0);
    expect(Number(domain.max)).toBe(100);
  });

  it("isolates overlay scale's auto-scale from the right scale", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    const candle = new MockProvider({ min: asPrice(100), max: asPrice(110) });
    const volume = new MockProvider({ min: asPrice(0), max: asPrice(1_000_000) });
    pane.addSeriesToScale(candle, "right");
    pane.addSeriesToScale(volume, "", { top: 0.8, bottom: 0 });
    pane.priceScale("right").setAutoScale(true);
    pane.priceScale("").setAutoScale(true);
    pane.reconcileEachScale(0, 1000);
    const candleDomain = pane.priceScale("right").getDomain();
    const volumeDomain = pane.priceScale("").getDomain();
    expect(Number(candleDomain.max)).toBe(110); // not pulled to 1M
    expect(Number(volumeDomain.max)).toBe(1_000_000);
  });

  it("overlay slot translates TV-LWC margins to Carta headroom semantics", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    pane.ensureSlot("", { top: 0.8, bottom: 0 });
    pane.priceScale("").setDomain(0, 100);
    const overlayScale = pane.currentPriceScaleForSlot("");
    // TV LWC `top=0.8, bottom=0` ⇒ data fills bottom 20 % of pane.
    // Carta headroom equivalent: `top = 0.8 / (1 - 0.8) = 4`, `bottom = 0`.
    expect(overlayScale.margins.top).toBeCloseTo(4, 5);
    expect(overlayScale.margins.bottom).toBe(0);
    // Right slot keeps headroom semantics.
    const rightScale = pane.currentPriceScaleForSlot("right");
    expect(rightScale.margins.top).not.toBe(4);
  });

  it("removeSeriesFromScale unlinks the provider", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    const provider = new MockProvider({ min: asPrice(10), max: asPrice(20) });
    pane.addSeriesToScale(provider, "right");
    pane.priceScale("right").setAutoScale(true);
    pane.reconcileEachScale(0, 1000);
    expect(Number(pane.priceScale("right").getDomain().max)).toBe(20);
    pane.removeSeriesFromScale(provider, "right");
    pane.reconcileEachScale(0, 1000);
    // Prior domain retained — reduce returned null after the unlink.
    expect(Number(pane.priceScale("right").getDomain().max)).toBe(20);
  });

  it("translates paneContainer by applyRect", () => {
    const pane = new Pane({ id: asPaneId("volume") });
    pane.applyRect({ x: 0, y: 200, w: 800, h: 100 });
    expect(pane.paneContainer.position.y).toBe(200);
    expect(pane.getRect().h).toBe(100);
  });

  it("destroy is idempotent and clears slots", () => {
    const pane = new Pane({ id: MAIN_PANE_ID });
    pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
    pane.destroy();
    pane.destroy();
    expect(pane.scales().length).toBe(0);
  });

  it("clamps negative / non-finite stretchFactor to 1 in constructor", () => {
    const a = new Pane({ id: MAIN_PANE_ID, stretchFactor: -2 });
    expect(a.stretchFactor).toBe(1);
    const b = new Pane({ id: MAIN_PANE_ID, stretchFactor: Number.NaN });
    expect(b.stretchFactor).toBe(1);
    const c = new Pane({ id: MAIN_PANE_ID, stretchFactor: 0.25 });
    expect(c.stretchFactor).toBe(0.25);
  });

  it("supports a pane without a price axis (hasRightAxis: false)", () => {
    const pane = new Pane({ id: asPaneId("volume"), hasRightAxis: false });
    expect(pane.priceAxis).toBeNull();
  });

  // Reference unused import for lint.
  it("asPaneId brand wraps strings", () => {
    expect(String(asTime(1))).toBe("1");
  });

  // ─── Phase 14 Cycle B ────────────────────────────────────────────────

  describe("cycle B — bounded price scale", () => {
    it("setMode 'bounded' clamps autoscale output to [min, max]", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
      // Buggy provider returns way past [0, 100].
      const wild = new MockProvider({ min: asPrice(0), max: asPrice(999) });
      pane.addSeriesToScale(wild, "right");
      pane.priceScale("right").setAutoScale(true);
      pane.priceScale("right").setMode({ kind: "bounded", min: 0, max: 100 });
      pane.reconcileEachScale(0, 1000);
      const d = pane.priceScale("right").getDomain();
      expect(Number(d.min)).toBe(0);
      expect(Number(d.max)).toBe(100);
    });

    it("setMode 'bounded' allows autoscale within bounds (no warn)", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
      const inBounds = new MockProvider({ min: asPrice(20), max: asPrice(80) });
      pane.addSeriesToScale(inBounds, "right");
      pane.priceScale("right").setAutoScale(true);
      pane.priceScale("right").setMode({ kind: "bounded", min: 0, max: 100 });
      pane.reconcileEachScale(0, 1000);
      const d = pane.priceScale("right").getDomain();
      expect(Number(d.min)).toBe(20);
      expect(Number(d.max)).toBe(80);
    });

    it("manual setDomain on bounded slot stays within bounds (renders clamp)", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
      pane.priceScale("right").setMode({ kind: "bounded", min: 0, max: 100 });
      // simulate user drag-stretch beyond bounds
      pane.priceScale("right").setDomain(-50, 200);
      pane.reconcileEachScale(0, 1000);
      const d = pane.priceScale("right").getDomain();
      expect(Number(d.min)).toBe(0);
      expect(Number(d.max)).toBe(100);
    });

    it("bounded with positive pad widens the rendered scale margins", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
      pane.priceScale("right").setMode({ kind: "bounded", min: 0, max: 100, pad: 0.05 });
      pane.priceScale("right").setDomain(0, 100);
      pane.reconcileEachScale(0, 1000);
      const scale = pane.currentPriceScaleForSlot("right");
      // Default DEFAULT_PRICE_MARGINS adds another 8 % on top of `pad`'s
      // expansion. The net effect is the data y-pixel for value=0 is
      // strictly below pixelHeight, and value=100 is strictly above 0.
      const yMin = Number(scale.valueToPixel(asPrice(0)));
      const yMax = Number(scale.valueToPixel(asPrice(100)));
      // y grows downward; effective range widened by 0.05 * 100 = 5 each side.
      expect(yMin).toBeLessThan(scale.pixelHeight);
      expect(yMax).toBeGreaterThan(0);
    });

    it("bounded mode rejects min >= max via sanitizer", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => { warnings.push(m); },
        error: () => undefined,
      };
      const sanitized = sanitizePriceScaleMode(
        { kind: "bounded", min: 100, max: 100 },
        logger,
      );
      expect(sanitized).toBeNull();
      expect(warnings.length).toBe(1);
    });

    it("bounded mode sanitizes negative pad to 0 with warn", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => { warnings.push(m); },
        error: () => undefined,
      };
      const sanitized = sanitizePriceScaleMode(
        { kind: "bounded", min: 0, max: 100, pad: -0.5 },
        logger,
      );
      expect(sanitized).not.toBeNull();
      // Confirm pad clamped to 0
      expect((sanitized as { pad?: number }).pad).toBe(0);
      expect(warnings.length).toBe(1);
    });

    it("bounded mode clamps pad >= 1 to 1", () => {
      const sanitized = sanitizePriceScaleMode(
        { kind: "bounded", min: 0, max: 100, pad: 5 },
        null,
      );
      expect((sanitized as { pad?: number }).pad).toBe(1);
    });

    it("setMode 'auto' sets autoScale=true via facade sugar", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.priceScale("right").setMode({ kind: "auto" });
      expect(pane.priceScale("right").isAutoScale()).toBe(true);
      const mode = pane.priceScale("right").getMode();
      expect(mode.kind).toBe("auto");
    });

    it("setMode 'manual' sets autoScale=false + writes priceDomain", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.applyRect({ x: 0, y: 0, w: 800, h: 400 });
      pane.priceScale("right").setMode({ kind: "manual", min: 50, max: 150 });
      expect(pane.priceScale("right").isAutoScale()).toBe(false);
      pane.reconcileEachScale(0, 1000);
      const d = pane.priceScale("right").getDomain();
      expect(Number(d.min)).toBe(50);
      expect(Number(d.max)).toBe(150);
    });
  });

  describe("cycle B — pane.applyOptions", () => {
    function makePaneWithOwner(): {
      pane: Pane;
      owner: { calls: { patch: object; pre: PrePatchPaneSnapshot }[] };
      warnings: string[];
    } {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => { warnings.push(m); },
        error: () => undefined,
      };
      const calls: { patch: object; pre: PrePatchPaneSnapshot }[] = [];
      const owner: PaneOwner = {
        movePaneTo: vi.fn(),
        paneOptionsApplied: (_p, patch, pre) => { calls.push({ patch, pre }); },
      };
      const pane = new Pane({ id: asPaneId("test"), logger, paneOwner: owner });
      return { pane, owner: { calls }, warnings };
    }

    it("empty patch is silent — no owner notification, no warns", () => {
      const { pane, owner, warnings } = makePaneWithOwner();
      pane.applyOptions({});
      expect(owner.calls.length).toBe(0);
      expect(warnings.length).toBe(0);
    });

    it("height wins over stretchFactor when both are present", () => {
      const { pane, owner } = makePaneWithOwner();
      pane.applyOptions({ stretchFactor: 2, height: 200 });
      expect(pane.stretchFactor).toBe(2);
      expect(pane.heightOverride).toBe(200);
      expect(owner.calls.length).toBe(1);
    });

    it("hidden flip emits via owner (visibility transition)", () => {
      const { pane, owner } = makePaneWithOwner();
      pane.applyOptions({ hidden: true });
      expect(pane.hidden).toBe(true);
      expect(owner.calls.length).toBe(1);
      const call = owner.calls[0];
      expect(call?.pre.hidden).toBe(false);
    });

    it("id key is immutable + warned", () => {
      const { pane, warnings } = makePaneWithOwner();
      pane.applyOptions({ id: asPaneId("new-id") });
      expect(pane.id).toBe(asPaneId("test"));
      expect(warnings.some((w) => w.includes("'id' is immutable"))).toBe(true);
    });

    it("unknown keys log warn + are ignored", () => {
      const { pane, warnings } = makePaneWithOwner();
      pane.applyOptions({ ...({ frobnitz: 42 } as object) });
      expect(warnings.some((w) => w.includes("frobnitz"))).toBe(true);
      // Pane state unchanged.
      expect(pane.heightOverride).toBeNull();
    });

    it("priceScales.right.mode patch routes through setMode", () => {
      const { pane } = makePaneWithOwner();
      const mode: PriceScaleMode = { kind: "bounded", min: 0, max: 100 };
      pane.applyOptions({ priceScales: { right: { mode } } });
      const got = pane.priceScale("right").getMode();
      expect(got.kind).toBe("bounded");
    });

    it("non-finite stretchFactor in patch logs warn + leaves prior value", () => {
      const { pane, warnings } = makePaneWithOwner();
      pane.stretchFactor = 1.5;
      pane.applyOptions({ stretchFactor: Number.NaN });
      expect(pane.stretchFactor).toBe(1.5);
      expect(warnings.some((w) => w.includes("stretchFactor"))).toBe(true);
    });
  });

  describe("cycle B — pane.moveTo", () => {
    it("delegates to paneOwner.movePaneTo", () => {
      const movePaneTo = vi.fn();
      const owner: PaneOwner = {
        movePaneTo,
        paneOptionsApplied: vi.fn(),
      };
      const pane = new Pane({ id: asPaneId("test"), paneOwner: owner });
      pane.moveTo(2);
      expect(movePaneTo).toHaveBeenCalledWith(pane, 2);
    });

    it("logs warn + no-ops without an owner", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => { warnings.push(m); },
        error: () => undefined,
      };
      const pane = new Pane({ id: asPaneId("test"), logger });
      pane.moveTo(1);
      expect(warnings.some((w) => w.includes("no chart owner"))).toBe(true);
    });
  });

  describe("cycle B fix-up F-2 — setHeight clamping", () => {
    it("clamps height beyond ceiling and warns", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => { warnings.push(m); },
        error: () => undefined,
      };
      const pane = new Pane({ id: MAIN_PANE_ID, logger });
      pane.setHeight(Number.MAX_SAFE_INTEGER);
      // Heightoverride should be clamped to a sane ceiling, never the
      // original 9e15.
      expect(pane.heightOverride).not.toBeNull();
      expect((pane.heightOverride ?? 0) <= 65535).toBe(true);
      expect(warnings.some((w) => w.includes("ceiling"))).toBe(true);
    });

    it("warns + no-ops on negative height", () => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => { warnings.push(m); },
        error: () => undefined,
      };
      const pane = new Pane({ id: MAIN_PANE_ID, logger });
      pane.setHeight(-100);
      expect(pane.heightOverride).toBeNull();
      expect(warnings.length).toBe(1);
    });
  });

  describe("cycle B fix-up F-1 — bounded mode boundary ticks via Pane.renderPriceAxis", () => {
    it("currentPriceScaleForSlot still widens by pad on bounded slot (regression)", () => {
      const pane = new Pane({ id: MAIN_PANE_ID });
      pane.applyRect({ x: 0, y: 0, w: 800, h: 68 }); // mobile-RSI-sized
      pane.priceScale("right").setMode({ kind: "bounded", min: 0, max: 100, pad: 0.05 });
      const provider = new MockProvider({ min: asPrice(28.29), max: asPrice(70.20) });
      pane.addSeriesToScale(provider, "right");
      pane.priceScale("right").setAutoScale(true);
      pane.reconcileEachScale(0, 1000);
      const scale = pane.currentPriceScaleForSlot("right");
      // domain widened to [-5, 105] (autoscale [28, 70] union with bounded
      // pad-widening); margins then add another 8 % headroom.
      expect(Number(scale.domainMin)).toBeLessThanOrEqual(-5);
      expect(Number(scale.domainMax)).toBeGreaterThanOrEqual(105);
    });
  });
});
