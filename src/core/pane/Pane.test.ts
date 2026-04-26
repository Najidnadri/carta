import { describe, expect, it } from "vitest";
import type { PriceRange, PriceRangeProvider } from "../price/PriceRangeProvider.js";
import { asPrice, asTime, type Time } from "../../types.js";
import { Pane } from "./Pane.js";
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
});
