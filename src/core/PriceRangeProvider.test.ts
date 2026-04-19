import { describe, expect, it } from "vitest";
import { asPrice, asTime } from "../types.js";
import {
  reducePriceRanges,
  type PriceRange,
  type PriceRangeProvider,
} from "./PriceRangeProvider.js";

const t0 = asTime(0);
const t1 = asTime(1_000);

function make(range: PriceRange | null): PriceRangeProvider {
  return { priceRangeInWindow: () => range };
}

describe("reducePriceRanges", () => {
  it("returns null for an empty set", () => {
    expect(reducePriceRanges(new Set(), t0, t1)).toBeNull();
  });

  it("returns null when all providers return null", () => {
    const set = new Set<PriceRangeProvider>([make(null), make(null)]);
    expect(reducePriceRanges(set, t0, t1)).toBeNull();
  });

  it("returns the single provider's range when only one contributes", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(10), max: asPrice(20) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(out).not.toBeNull();
    expect(Number(out?.min)).toBe(10);
    expect(Number(out?.max)).toBe(20);
  });

  it("reduces multiple providers to min-of-mins and max-of-maxes", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(10), max: asPrice(20) }),
      make({ min: asPrice(5), max: asPrice(15) }),
      make({ min: asPrice(12), max: asPrice(30) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(Number(out?.min)).toBe(5);
    expect(Number(out?.max)).toBe(30);
  });

  it("filters out providers with NaN min or max", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(Number.NaN), max: asPrice(100) }),
      make({ min: asPrice(10), max: asPrice(20) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(Number(out?.min)).toBe(10);
    expect(Number(out?.max)).toBe(20);
  });

  it("filters out providers with ±Infinity values", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(Number.NEGATIVE_INFINITY), max: asPrice(100) }),
      make({ min: asPrice(0), max: asPrice(Number.POSITIVE_INFINITY) }),
      make({ min: asPrice(10), max: asPrice(20) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(Number(out?.min)).toBe(10);
    expect(Number(out?.max)).toBe(20);
  });

  it("filters out providers with min > max", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(100), max: asPrice(50) }),
      make({ min: asPrice(10), max: asPrice(20) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(Number(out?.min)).toBe(10);
    expect(Number(out?.max)).toBe(20);
  });

  it("accepts a flat range (min === max)", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(42), max: asPrice(42) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(Number(out?.min)).toBe(42);
    expect(Number(out?.max)).toBe(42);
  });

  it("returns null when every provider is individually invalid", () => {
    const set = new Set<PriceRangeProvider>([
      make({ min: asPrice(Number.NaN), max: asPrice(Number.NaN) }),
      make({ min: asPrice(100), max: asPrice(50) }),
      make(null),
    ]);
    expect(reducePriceRanges(set, t0, t1)).toBeNull();
  });

  it("swallows provider throws and treats as null", () => {
    const thrower: PriceRangeProvider = {
      priceRangeInWindow: () => {
        throw new Error("nope");
      },
    };
    const set = new Set<PriceRangeProvider>([
      thrower,
      make({ min: asPrice(10), max: asPrice(20) }),
    ]);
    const out = reducePriceRanges(set, t0, t1);
    expect(Number(out?.min)).toBe(10);
    expect(Number(out?.max)).toBe(20);
  });

  it("returns null when every provider throws", () => {
    const thrower: PriceRangeProvider = {
      priceRangeInWindow: () => {
        throw new Error("nope");
      },
    };
    const set = new Set<PriceRangeProvider>([thrower, thrower]);
    expect(reducePriceRanges(set, t0, t1)).toBeNull();
  });
});
