import type { Time } from "../../types.js";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

export type StepTier = "sec" | "min" | "time" | "date" | "monthYear";

export interface FormatContext {
  readonly locale?: string;
  readonly timeZone?: string;
}

/**
 * Classifies a natural step into one of five format tiers.
 */
export function tierOfStep(step: number): StepTier {
  if (step < MIN) {
    return "sec";
  }
  if (step < HOUR) {
    return "min";
  }
  if (step < DAY) {
    return "time";
  }
  if (step < MONTH) {
    return "date";
  }
  return "monthYear";
}

// ─── DTF cache (one formatter per (tier, locale, timeZone) — never evicted) ──
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(tier: StepTier, ctx: FormatContext | undefined): Intl.DateTimeFormat {
  const locale = ctx?.locale ?? "default";
  const tz = ctx?.timeZone ?? "default";
  const key = `${tier}|${locale}|${tz}`;
  const cached = dtfCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const opts: Intl.DateTimeFormatOptions = dtfOptions(tier);
  if (ctx?.timeZone !== undefined) {
    opts.timeZone = ctx.timeZone;
  }
  const dtf = new Intl.DateTimeFormat(ctx?.locale, opts);
  dtfCache.set(key, dtf);
  return dtf;
}

function dtfOptions(tier: StepTier): Intl.DateTimeFormatOptions {
  switch (tier) {
    case "sec":
      return { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
    case "min":
    case "time":
      return { hour: "2-digit", minute: "2-digit", hour12: false };
    case "date":
      return { month: "short", day: "numeric" };
    case "monthYear":
      return { month: "short", year: "numeric" };
  }
}

// ─── Day-key DTF (used to detect day-boundary promotion) ─────────────────────
const dayKeyCache = new Map<string, Intl.DateTimeFormat>();

function getDayKeyDtf(ctx: FormatContext | undefined): Intl.DateTimeFormat {
  const locale = ctx?.locale ?? "default";
  const tz = ctx?.timeZone ?? "default";
  const key = `${locale}|${tz}`;
  const cached = dayKeyCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  if (ctx?.timeZone !== undefined) {
    opts.timeZone = ctx.timeZone;
  }
  const dtf = new Intl.DateTimeFormat(ctx?.locale ?? "en-CA", opts);
  dayKeyCache.set(key, dtf);
  return dtf;
}

export function dayKeyOf(time: Time, ctx?: FormatContext): string {
  return getDayKeyDtf(ctx).format(Number(time));
}

// ─── LRU for formatted label strings ─────────────────────────────────────────
const LRU_CAP = 512;

class StringLru {
  private readonly map = new Map<string, string>();
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: string): string | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

const labelCache = new StringLru(LRU_CAP);

// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Formats an axis label for `time` given the chosen natural `step`. When
 * `isDayBoundary` is true and the step is intraday (< 1 day), the label is
 * promoted to a date instead of a time.
 */
export function formatAxisLabel(
  time: Time,
  step: number,
  isDayBoundary: boolean,
  ctx?: FormatContext,
): string {
  const baseTier = tierOfStep(step);
  const effectiveTier: StepTier =
    isDayBoundary && (baseTier === "sec" || baseTier === "min" || baseTier === "time")
      ? "date"
      : baseTier;
  const localeKey = ctx?.locale ?? "default";
  const tzKey = ctx?.timeZone ?? "default";
  const key = `${effectiveTier}|${localeKey}|${tzKey}|${String(Number(time))}`;
  const hit = labelCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const formatted = getDtf(effectiveTier, ctx).format(Number(time));
  labelCache.set(key, formatted);
  return formatted;
}

/**
 * Phase 13 Cycle B.2 — adaptive duration string for date-range / position
 * "time elapsed" readouts. Adaptive precision: days-and-hours for ≥ 1 day,
 * hours-and-minutes for ≥ 1 hour, etc. Single-unit output for the smallest
 * tier (e.g. `"42s"`, not `"0m 42s"`). Negative durations are `-`-prefixed.
 * NaN / non-finite returns `"—"`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  if (ms === 0) {
    return "0s";
  }
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs >= DAY) {
    const d = Math.floor(abs / DAY);
    const h = Math.floor((abs % DAY) / HOUR);
    return h === 0 ? `${sign}${String(d)}d` : `${sign}${String(d)}d ${String(h)}h`;
  }
  if (abs >= HOUR) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MIN);
    return m === 0 ? `${sign}${String(h)}h` : `${sign}${String(h)}h ${String(m)}m`;
  }
  if (abs >= MIN) {
    const m = Math.floor(abs / MIN);
    const s = Math.floor((abs % MIN) / SEC);
    return s === 0 ? `${sign}${String(m)}m` : `${sign}${String(m)}m ${String(s)}s`;
  }
  const s = Math.floor(abs / SEC);
  if (s === 0) {
    // Sub-second fall-through — show ms.
    return `${sign}${String(abs)}ms`;
  }
  return `${sign}${String(s)}s`;
}

/**
 * Test hook — lets unit tests inspect LRU state and reset caches.
 */
export const __internals__ = {
  labelCacheSize: (): number => labelCache.size,
  resetCaches: (): void => {
    labelCache.clear();
    dtfCache.clear();
    dayKeyCache.clear();
  },
  LRU_CAP,
};
