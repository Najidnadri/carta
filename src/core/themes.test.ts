import { describe, expect, it } from "vitest";
import { DarkTheme, LightTheme } from "./themes.js";
import type { Theme } from "../types.js";

const REQUIRED_KEYS: readonly (keyof Theme)[] = [
  "background",
  "grid",
  "gridAlpha",
  "frame",
  "text",
  "textMuted",
  "up",
  "down",
  "line",
  "areaTop",
  "areaBottom",
  "histogramUp",
  "histogramDown",
  "baselinePositiveTop",
  "baselinePositiveBottom",
  "baselineNegativeTop",
  "baselineNegativeBottom",
  "crosshairLine",
  "crosshairTagBg",
  "crosshairTagText",
  "fontFamily",
  "fontSize",
];

describe("Theme presets", () => {
  it("DarkTheme exposes every required slot", () => {
    for (const key of REQUIRED_KEYS) {
      expect(DarkTheme[key]).toBeDefined();
    }
  });

  it("LightTheme exposes every required slot", () => {
    for (const key of REQUIRED_KEYS) {
      expect(LightTheme[key]).toBeDefined();
    }
  });

  it("DarkTheme.background and LightTheme.background diverge", () => {
    expect(DarkTheme.background).not.toBe(LightTheme.background);
  });

  it("LightTheme uses a white background and dark text", () => {
    expect(LightTheme.background).toBe(0xffffff);
    // Text on light bg should be at the dark end of the spectrum.
    expect(LightTheme.text).toBeLessThan(0x808080);
    expect(LightTheme.textMuted).toBeLessThan(0x808080);
  });

  it("DarkTheme uses a near-black background and light text", () => {
    expect(DarkTheme.background).toBeLessThan(0x202020);
    expect(DarkTheme.text).toBeGreaterThan(0x808080);
  });

  it("gridAlpha is 1.0 on Dark and ≤0.8 on Light", () => {
    expect(DarkTheme.gridAlpha).toBe(1);
    expect(LightTheme.gridAlpha).toBeLessThanOrEqual(0.8);
    expect(LightTheme.gridAlpha).toBeGreaterThan(0);
  });

  it("fontFamily is a non-empty system stack and fontSize is positive", () => {
    expect(DarkTheme.fontFamily.length).toBeGreaterThan(0);
    expect(DarkTheme.fontSize).toBeGreaterThan(0);
    expect(LightTheme.fontFamily.length).toBeGreaterThan(0);
    expect(LightTheme.fontSize).toBeGreaterThan(0);
  });

  it("partial spread merge preserves omitted slots", () => {
    const merged: Theme = { ...DarkTheme, fontFamily: "Georgia, serif" };
    expect(merged.fontFamily).toBe("Georgia, serif");
    // Every other slot should match Dark.
    expect(merged.up).toBe(DarkTheme.up);
    expect(merged.down).toBe(DarkTheme.down);
    expect(merged.background).toBe(DarkTheme.background);
    expect(merged.gridAlpha).toBe(DarkTheme.gridAlpha);
  });

  it("LightTheme tag colors invert against light surface", () => {
    // Dark tag bg + light tag text reads correctly on a white chart.
    expect(LightTheme.crosshairTagBg).toBeLessThan(0x808080);
    expect(LightTheme.crosshairTagText).toBeGreaterThan(0x808080);
  });
});
