import { describe, expect, it } from "vitest";
import { simplifyRdp } from "./rdp.js";

describe("simplifyRdp", () => {
  it("returns identity on inputs with fewer than 3 points", () => {
    const a = simplifyRdp([], 1);
    expect(a).toEqual([]);
    const b = simplifyRdp([{ x: 0, y: 0 }], 1);
    expect(b).toEqual([{ x: 0, y: 0 }]);
    const c = simplifyRdp([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1);
    expect(c).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("collapses collinear points to the endpoints", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = simplifyRdp(pts, 0.5);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("preserves a midpoint when its perpendicular distance exceeds epsilon", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    const result = simplifyRdp(pts, 1);
    expect(result).toEqual(pts);
  });

  it("drops a midpoint when its perpendicular distance is below epsilon", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
    ];
    const result = simplifyRdp(pts, 1);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("epsilon=0 is identity (no simplification)", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
    ];
    const result = simplifyRdp(pts, 0);
    expect(result).toEqual(pts);
  });

  it("non-finite epsilon is identity", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    expect(simplifyRdp(pts, NaN)).toEqual(pts);
    expect(simplifyRdp(pts, Infinity)).toEqual(pts);
  });

  it("filters out non-finite points before simplification", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: NaN, y: 5 },
      { x: 5, y: 0 },
      { x: 10, y: Infinity },
      { x: 20, y: 0 },
    ];
    const result = simplifyRdp(pts, 0.5);
    // After NaN/Infinity filtered out, the remaining 3 collinear points collapse.
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  });

  it("large epsilon collapses to 2 endpoints", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 7, y: -5 },
      { x: 10, y: 0 },
    ];
    expect(simplifyRdp(pts, 100)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("handles 10000 points within 50 ms", () => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 10000; i++) {
      pts.push({ x: i, y: Math.sin(i / 30) * 5 });
    }
    const start = performance.now();
    const result = simplifyRdp(pts, 1);
    const elapsed = performance.now() - start;
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThan(pts.length);
    expect(elapsed).toBeLessThan(50);
  });

  it("returns a frozen result", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ];
    const result = simplifyRdp(pts, 0.5);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("is iterative — does not blow the stack on 50 000 points", () => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 50000; i++) {
      pts.push({ x: i, y: i % 2 === 0 ? 0 : 0.1 });
    }
    expect(() => simplifyRdp(pts, 1)).not.toThrow();
  });
});
