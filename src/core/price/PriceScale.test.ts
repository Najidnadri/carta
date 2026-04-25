import { describe, expect, it } from "vitest";
import { asPixel, asPrice } from "../../types.js";
import { DEFAULT_PRICE_MARGINS, PriceScale } from "./PriceScale.js";

const NO_MARGINS = { top: 0, bottom: 0 };

describe("PriceScale — valid linear projection", () => {
  const scale = new PriceScale({
    domainMin: asPrice(100),
    domainMax: asPrice(200),
    pixelHeight: 400,
    margins: NO_MARGINS,
  });

  it("is marked valid", () => {
    expect(scale.valid).toBe(true);
  });

  it("projects max to y=0 and min to y=pixelHeight (Pixi top-down)", () => {
    expect(Number(scale.valueToPixel(asPrice(200)))).toBeCloseTo(0, 6);
    expect(Number(scale.valueToPixel(asPrice(100)))).toBeCloseTo(400, 6);
  });

  it("projects midpoint to pixelHeight/2", () => {
    expect(Number(scale.valueToPixel(asPrice(150)))).toBeCloseTo(200, 6);
  });

  it("pixel ↔ value roundtrips within float tolerance", () => {
    for (const y of [0, 50, 100, 200, 300, 400]) {
      const v = Number(scale.pixelToValue(asPixel(y)));
      const back = Number(scale.valueToPixel(asPrice(v)));
      expect(back).toBeCloseTo(y, 4);
    }
  });
});

describe("PriceScale — margins", () => {
  it("top/bottom 0.1 inflates effective domain by 10% each side", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(100),
      pixelHeight: 500,
      margins: { top: 0.1, bottom: 0.1 },
    });
    expect(scale.effectiveMin).toBeCloseTo(-10, 6);
    expect(scale.effectiveMax).toBeCloseTo(110, 6);
    expect(Number(scale.valueToPixel(asPrice(100)))).toBeGreaterThan(0);
    expect(Number(scale.valueToPixel(asPrice(0)))).toBeLessThan(500);
  });

  it("default margins match 0.08/0.08", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(1),
      pixelHeight: 100,
    });
    expect(scale.margins.top).toBe(DEFAULT_PRICE_MARGINS.top);
    expect(scale.margins.bottom).toBe(DEFAULT_PRICE_MARGINS.bottom);
  });

  it("negative or non-finite margin values fall back to defaults", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(1),
      pixelHeight: 100,
      margins: { top: Number.NaN, bottom: -1 },
    });
    expect(scale.margins.top).toBe(DEFAULT_PRICE_MARGINS.top);
    expect(scale.margins.bottom).toBe(DEFAULT_PRICE_MARGINS.bottom);
  });
});

describe("PriceScale — zero-height domain inflation", () => {
  it("min === max inflates by ±1% of |min| when min is non-zero", () => {
    const scale = new PriceScale({
      domainMin: asPrice(200),
      domainMax: asPrice(200),
      pixelHeight: 400,
      margins: NO_MARGINS,
    });
    expect(scale.effectiveMin).toBeCloseTo(198, 6);
    expect(scale.effectiveMax).toBeCloseTo(202, 6);
    expect(scale.valid).toBe(true);
  });

  it("min === max === 0 inflates by ±0.5", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(0),
      pixelHeight: 400,
      margins: NO_MARGINS,
    });
    expect(scale.effectiveMin).toBeCloseTo(-0.5, 6);
    expect(scale.effectiveMax).toBeCloseTo(0.5, 6);
  });

  it("min === max === negative inflates by ±1% of |min|", () => {
    const scale = new PriceScale({
      domainMin: asPrice(-50),
      domainMax: asPrice(-50),
      pixelHeight: 400,
      margins: NO_MARGINS,
    });
    expect(scale.effectiveMin).toBeCloseTo(-50.5, 6);
    expect(scale.effectiveMax).toBeCloseTo(-49.5, 6);
  });
});

describe("PriceScale — degenerate inputs (graceful)", () => {
  it("NaN domainMin yields valid=false and safe fallback values", () => {
    const scale = new PriceScale({
      domainMin: asPrice(Number.NaN),
      domainMax: asPrice(100),
      pixelHeight: 400,
    });
    expect(scale.valid).toBe(false);
    expect(Number(scale.valueToPixel(asPrice(50)))).toBe(0);
  });

  it("Infinity domainMax yields valid=false", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(Number.POSITIVE_INFINITY),
      pixelHeight: 400,
    });
    expect(scale.valid).toBe(false);
  });

  it("zero pixelHeight yields valid=false", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(100),
      pixelHeight: 0,
    });
    expect(scale.valid).toBe(false);
  });

  it("negative pixelHeight yields valid=false", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(100),
      pixelHeight: -10,
    });
    expect(scale.valid).toBe(false);
  });

  it("min > max yields valid=false (no auto-swap)", () => {
    const scale = new PriceScale({
      domainMin: asPrice(100),
      domainMax: asPrice(50),
      pixelHeight: 400,
    });
    expect(scale.valid).toBe(false);
  });

  it("pixelToValue on invalid returns a finite midpoint without crashing", () => {
    const scale = new PriceScale({
      domainMin: asPrice(Number.NaN),
      domainMax: asPrice(Number.NaN),
      pixelHeight: 400,
    });
    expect(Number.isFinite(Number(scale.pixelToValue(asPixel(123))))).toBe(true);
  });
});

describe("PriceScale — identity mutators", () => {
  it("withDomain returns same instance when unchanged", () => {
    const min = asPrice(0);
    const max = asPrice(1);
    const scale = new PriceScale({
      domainMin: min,
      domainMax: max,
      pixelHeight: 100,
    });
    expect(scale.withDomain(min, max)).toBe(scale);
  });

  it("withPixelHeight returns same instance when unchanged", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(1),
      pixelHeight: 100,
    });
    expect(scale.withPixelHeight(100)).toBe(scale);
  });

  it("withDomain returns a new scale with new effective range", () => {
    const scale = new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(1),
      pixelHeight: 100,
      margins: NO_MARGINS,
    });
    const next = scale.withDomain(asPrice(10), asPrice(20));
    expect(next).not.toBe(scale);
    expect(next.effectiveMin).toBeCloseTo(10, 6);
    expect(next.effectiveMax).toBeCloseTo(20, 6);
  });
});

describe("PriceScale — extreme magnitudes", () => {
  it("projects a BTC-scale range (1e5) without precision loss at midpoint", () => {
    const scale = new PriceScale({
      domainMin: asPrice(60_000),
      domainMax: asPrice(80_000),
      pixelHeight: 400,
      margins: NO_MARGINS,
    });
    expect(Number(scale.valueToPixel(asPrice(70_000)))).toBeCloseTo(200, 3);
  });

  it("projects a sub-penny range (1e-9) with sensible output", () => {
    const scale = new PriceScale({
      domainMin: asPrice(1e-9),
      domainMax: asPrice(2e-9),
      pixelHeight: 400,
      margins: NO_MARGINS,
    });
    expect(Number(scale.valueToPixel(asPrice(1.5e-9)))).toBeCloseTo(200, 3);
  });
});
