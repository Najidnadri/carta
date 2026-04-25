import { describe, expect, it } from "vitest";
import { isAscending, lowerBound, upperBound } from "./sortedArray.js";

describe("lowerBound", () => {
  it("returns 0 for empty array", () => {
    expect(lowerBound([], 5)).toBe(0);
  });

  it("returns 0 when target is below every element", () => {
    expect(lowerBound([10, 20, 30], 0)).toBe(0);
  });

  it("returns length when target is above every element", () => {
    expect(lowerBound([10, 20, 30], 40)).toBe(3);
  });

  it("returns the index of the first equal element", () => {
    expect(lowerBound([10, 20, 30], 20)).toBe(1);
  });

  it("returns the insertion point between elements", () => {
    expect(lowerBound([10, 20, 30], 25)).toBe(2);
  });

  it("handles duplicates (returns leftmost match)", () => {
    expect(lowerBound([10, 20, 20, 20, 30], 20)).toBe(1);
  });

  it("scales to large arrays", () => {
    const arr = Array.from({ length: 10_000 }, (_, i) => i * 2);
    expect(lowerBound(arr, 9999)).toBe(5000);
    expect(lowerBound(arr, 10_000)).toBe(5000);
    expect(lowerBound(arr, 10_001)).toBe(5001);
  });

  it("handles negative target on positive array", () => {
    expect(lowerBound([1, 2, 3], -10)).toBe(0);
  });

  it("handles NaN target deterministically (never equals or less-than, lands at end)", () => {
    // `NaN < x` is always false → lo never advances, but initial hi === length
    // and the loop terminates with lo === 0 because `arr[mid] < NaN` is also
    // false, so hi collapses to 0. Documented behavior: don't pass NaN.
    expect(lowerBound([1, 2, 3], Number.NaN)).toBe(0);
  });

  it("handles Infinity target", () => {
    expect(lowerBound([1, 2, 3], Number.POSITIVE_INFINITY)).toBe(3);
    expect(lowerBound([1, 2, 3], Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("upperBound", () => {
  it("returns 0 for empty array", () => {
    expect(upperBound([], 5)).toBe(0);
  });

  it("returns length when target is >= every element", () => {
    expect(upperBound([10, 20, 30], 30)).toBe(3);
    expect(upperBound([10, 20, 30], 40)).toBe(3);
  });

  it("skips past duplicates", () => {
    expect(upperBound([10, 20, 20, 20, 30], 20)).toBe(4);
  });
});

describe("isAscending", () => {
  it("true for empty / single", () => {
    expect(isAscending([])).toBe(true);
    expect(isAscending([5])).toBe(true);
  });

  it("true for strictly ascending", () => {
    expect(isAscending([1, 2, 3, 4])).toBe(true);
  });

  it("true for non-strictly ascending (ties allowed)", () => {
    expect(isAscending([1, 2, 2, 3])).toBe(true);
  });

  it("false for a single descent", () => {
    expect(isAscending([1, 3, 2, 4])).toBe(false);
  });
});
