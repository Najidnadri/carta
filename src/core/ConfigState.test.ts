import { describe, expect, it } from "vitest";
import { ConfigState, type ConfigStateSnapshot } from "./ConfigState.js";
import { asInterval, asTime, DEFAULT_THEME } from "../types.js";

const baseSnapshot = (): ConfigStateSnapshot => ({
  startTime: asTime(0),
  endTime: asTime(60_000),
  intervalDuration: asInterval(1_000),
  width: 800,
  height: 400,
  theme: DEFAULT_THEME,
});

describe("ConfigState", () => {
  it("freezes the snapshot to guard against mutation", () => {
    const cfg = new ConfigState(baseSnapshot());
    expect(Object.isFrozen(cfg.snapshot)).toBe(true);
  });

  it("withWindow returns same instance when values unchanged", () => {
    const cfg = new ConfigState(baseSnapshot());
    const same = cfg.withWindow(asTime(0), asTime(60_000));
    expect(same).toBe(cfg);
  });

  it("withWindow returns new instance when start changes", () => {
    const cfg = new ConfigState(baseSnapshot());
    const next = cfg.withWindow(asTime(1_000), asTime(60_000));
    expect(next).not.toBe(cfg);
    expect(next.snapshot.startTime).toBe(1_000);
    expect(next.snapshot.endTime).toBe(60_000);
  });

  it("withInterval returns new instance and preserves other fields", () => {
    const cfg = new ConfigState(baseSnapshot());
    const next = cfg.withInterval(asInterval(5_000));
    expect(next.snapshot.intervalDuration).toBe(5_000);
    expect(next.snapshot.width).toBe(800);
    expect(next.snapshot.theme).toBe(DEFAULT_THEME);
  });

  it("withInterval returns same instance when unchanged", () => {
    const cfg = new ConfigState(baseSnapshot());
    expect(cfg.withInterval(asInterval(1_000))).toBe(cfg);
  });

  it("withSize returns new instance when either dim changes", () => {
    const cfg = new ConfigState(baseSnapshot());
    expect(cfg.withSize(800, 400)).toBe(cfg);
    const wider = cfg.withSize(900, 400);
    expect(wider).not.toBe(cfg);
    expect(wider.snapshot.width).toBe(900);
    const taller = cfg.withSize(800, 500);
    expect(taller).not.toBe(cfg);
    expect(taller.snapshot.height).toBe(500);
  });

  it("withTheme uses identity comparison", () => {
    const cfg = new ConfigState(baseSnapshot());
    expect(cfg.withTheme(DEFAULT_THEME)).toBe(cfg);
    const newTheme = { ...DEFAULT_THEME };
    const next = cfg.withTheme(newTheme);
    expect(next).not.toBe(cfg);
    expect(next.snapshot.theme).toBe(newTheme);
  });
});
