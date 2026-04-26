import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asTime } from "../../types.js";
import {
  __internals__,
  dayKeyOf,
  formatAxisLabel,
  formatDuration,
  tierOfStep,
} from "./timeFormat.js";

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

const CTX = { locale: "en-US", timeZone: "UTC" } as const;

beforeEach(() => {
  __internals__.resetCaches();
});

afterEach(() => {
  __internals__.resetCaches();
});

describe("tierOfStep", () => {
  it("maps steps to the correct tier", () => {
    expect(tierOfStep(SEC)).toBe("sec");
    expect(tierOfStep(MIN)).toBe("min");
    expect(tierOfStep(HOUR)).toBe("time");
    expect(tierOfStep(DAY)).toBe("date");
    expect(tierOfStep(MONTH)).toBe("monthYear");
  });
});

describe("formatAxisLabel — five tiers", () => {
  const sampleUtc = Date.UTC(2026, 3, 19, 12, 34, 56); // 2026-04-19T12:34:56Z

  it("second tier → HH:MM:SS", () => {
    expect(formatAxisLabel(asTime(sampleUtc), SEC, false, CTX)).toBe("12:34:56");
  });

  it("minute tier → HH:MM", () => {
    expect(formatAxisLabel(asTime(sampleUtc), MIN, false, CTX)).toBe("12:34");
  });

  it("hour-scale (time) tier → HH:MM", () => {
    expect(formatAxisLabel(asTime(sampleUtc), HOUR, false, CTX)).toBe("12:34");
  });

  it("day tier → short month + numeric day", () => {
    const label = formatAxisLabel(asTime(sampleUtc), DAY, false, CTX);
    expect(label).toContain("Apr");
    expect(label).toContain("19");
  });

  it("month tier → short month + year", () => {
    const label = formatAxisLabel(asTime(sampleUtc), MONTH, false, CTX);
    expect(label).toContain("Apr");
    expect(label).toContain("2026");
  });
});

describe("formatAxisLabel — day-boundary promotion", () => {
  it("intraday tick gets promoted to date when isDayBoundary=true", () => {
    const t = Date.UTC(2026, 3, 19, 0, 0, 0);
    const time = formatAxisLabel(asTime(t), HOUR, false, CTX);
    const date = formatAxisLabel(asTime(t), HOUR, true, CTX);
    expect(time).toBe("00:00");
    expect(date).toContain("Apr");
  });

  it("day-or-larger steps ignore isDayBoundary (already a date)", () => {
    const t = Date.UTC(2026, 3, 19);
    const a = formatAxisLabel(asTime(t), DAY, false, CTX);
    const b = formatAxisLabel(asTime(t), DAY, true, CTX);
    expect(a).toBe(b);
  });
});

describe("dayKeyOf", () => {
  it("produces a stable per-day key in UTC", () => {
    const midnightA = Date.UTC(2026, 3, 19, 0, 0, 1);
    const afternoonA = Date.UTC(2026, 3, 19, 15, 0, 0);
    const midnightB = Date.UTC(2026, 3, 20, 0, 0, 1);
    expect(dayKeyOf(asTime(midnightA), CTX)).toBe(dayKeyOf(asTime(afternoonA), CTX));
    expect(dayKeyOf(asTime(midnightA), CTX)).not.toBe(dayKeyOf(asTime(midnightB), CTX));
  });
});

describe("LRU eviction", () => {
  it("evicts oldest entry when past cap", () => {
    const cap = __internals__.LRU_CAP;
    // Fill just past the cap with unique timestamps + unique step tiers.
    for (let i = 0; i <= cap; i++) {
      formatAxisLabel(asTime(i * SEC), SEC, false, CTX);
    }
    expect(__internals__.labelCacheSize()).toBe(cap);
  });

  it("cached lookup hits without growing the cache", () => {
    const t = asTime(Date.UTC(2026, 3, 19, 12, 34, 0));
    formatAxisLabel(t, MIN, false, CTX);
    const sizeAfterFirst = __internals__.labelCacheSize();
    formatAxisLabel(t, MIN, false, CTX);
    expect(__internals__.labelCacheSize()).toBe(sizeAfterFirst);
  });
});

describe("formatDuration", () => {
  it("returns 0s for zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats sub-second durations as ms", () => {
    expect(formatDuration(123)).toBe("123ms");
  });

  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(42 * SEC)).toBe("42s");
  });

  it("formats minutes-and-seconds (m + s when s > 0)", () => {
    expect(formatDuration(3 * MIN + 12 * SEC)).toBe("3m 12s");
  });

  it("formats whole minutes without s suffix", () => {
    expect(formatDuration(5 * MIN)).toBe("5m");
  });

  it("formats hours-and-minutes", () => {
    expect(formatDuration(5 * HOUR + 30 * MIN)).toBe("5h 30m");
    expect(formatDuration(2 * HOUR)).toBe("2h");
  });

  it("formats days-and-hours", () => {
    expect(formatDuration(2 * DAY + 4 * HOUR)).toBe("2d 4h");
    expect(formatDuration(7 * DAY)).toBe("7d");
  });

  it("prefixes negative durations with '-'", () => {
    expect(formatDuration(-3 * MIN)).toBe("-3m");
    expect(formatDuration(-(2 * HOUR + 30 * MIN))).toBe("-2h 30m");
  });

  it("returns em-dash for non-finite", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});
