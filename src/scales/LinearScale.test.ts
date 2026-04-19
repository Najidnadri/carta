import { describe, expect, it } from "vitest";
import { LinearScale } from "./LinearScale.js";

describe("LinearScale", () => {
  it("maps domain to range linearly", () => {
    const s = new LinearScale().setDomain(0, 100).setRange(0, 200);
    expect(s.toPixel(0)).toBe(0);
    expect(s.toPixel(50)).toBe(100);
    expect(s.toPixel(100)).toBe(200);
  });

  it("inverts pixel back to value", () => {
    const s = new LinearScale().setDomain(10, 20).setRange(0, 100);
    expect(s.toValue(0)).toBe(10);
    expect(s.toValue(50)).toBe(15);
    expect(s.toValue(100)).toBe(20);
  });

  it("supports inverted range for y-axis", () => {
    const s = new LinearScale().setDomain(0, 100).setRange(400, 0);
    expect(s.toPixel(0)).toBe(400);
    expect(s.toPixel(100)).toBe(0);
  });
});
