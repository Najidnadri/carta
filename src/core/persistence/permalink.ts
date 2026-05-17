/**
 * Phase 15 Cycle B — URL permalink encode/decode.
 *
 * Two tiers:
 *
 * - **Minimal (Tier 1)** — `URLSearchParams` of a handful of control fields
 *   (`c=1&s=AAPL&i=60000&f=...&t=...&th=dark&y=candle`). Always short
 *   enough to drop into Slack without overflowing 200 chars. Drops every
 *   higher-order field (drawings, panes, theme overrides, series options)
 *   — host re-binds those via UI after load.
 * - **Full (Tier 2)** — `chart.save()` snapshot, `JSON.stringify`'d,
 *   `lz-string compressToEncodedURIComponent`'d, prefixed `#z=`. Round-trips
 *   the entire schema; capped at 8192 chars by default (rejects past that
 *   with `PermalinkTooLargeError` rather than silently dropping bytes).
 *
 * `'auto'` tier (the default) picks `'minimal'` for "shareable control
 * protocol" states and `'full'` whenever there's lossy info that would
 * disappear (drawings present, ≥ 2 series, custom theme, theme overrides,
 * extra panes). This avoids the trap where a trader hits Share with 30
 * drawings and silently gets a short URL that drops them.
 *
 * Decoder is fail-loud: zero `as` casts on the public boundary, every
 * Tier 1 field is validated, Tier 2 runs through the same
 * `migrate → isChartSaveState` pipeline as `chart.load`.
 */

import { asInterval, asTime } from "../../types.js";
import { MAIN_PANE_ID } from "../drawings/types.js";
import type { ChartSaveState, SeriesKind } from "./types.js";
import {
  CARTA_SCHEMA_VERSION,
  CartaSchemaError,
  PermalinkTooLargeError,
  SERIES_KINDS,
} from "./types.js";
import type { PermalinkOptions, PermalinkTier } from "./types.js";
import { isChartSaveState } from "./validate.js";
import { migrate } from "./migrate.js";
import { lzDecode, lzEncode } from "./lzCodec.js";

const TIER1_SCHEMA_VERSION = "1";
const DEFAULT_MAX_ENCODED_LENGTH = 8192;
const TIER1_MAX_LENGTH = 200;

const THEME_NAMES: readonly string[] = ["light", "dark", "custom"];

/**
 * Friend interface — the encoder needs to call `chart.save()` to build the
 * Tier 2 snapshot and to inspect the live state for the auto-tier decision.
 */
export interface PermalinkContext {
  readonly buildSaveState: () => ChartSaveState;
}

function looksLikeMinimal(state: ChartSaveState): boolean {
  // No drawings.
  if (state.drawings !== undefined && state.drawings.drawings.length > 0) {
    return false;
  }
  // ≤ 1 series.
  if (state.series.length > 1) {
    return false;
  }
  // No panes beyond primary. `panes` may be omitted entirely, contain only
  // the primary pane, or be undefined — all minimal-eligible.
  const panes = state.panes;
  if (panes !== undefined) {
    for (const p of panes) {
      if (p.id !== MAIN_PANE_ID) {
        return false;
      }
    }
  }
  // Theme is a preset and carries no overrides.
  const theme = state.theme;
  if (theme !== undefined) {
    if (theme.name === "custom") {
      return false;
    }
    const overrides = theme.overrides;
    if (overrides !== undefined && Object.keys(overrides).length > 0) {
      return false;
    }
  }
  return true;
}

function resolveTier(
  explicit: PermalinkTier | "auto" | undefined,
  state: ChartSaveState,
): PermalinkTier {
  if (explicit === "minimal" || explicit === "full") {
    return explicit;
  }
  return looksLikeMinimal(state) ? "minimal" : "full";
}

function encodeMinimal(state: ChartSaveState): string {
  const params = new URLSearchParams();
  params.set("c", TIER1_SCHEMA_VERSION);
  params.set("pc", state.primaryChannelId);
  params.set("i", String(Number(state.intervalDuration)));
  params.set("f", String(Number(state.window.startTime)));
  params.set("t", String(Number(state.window.endTime)));
  params.set("y", state.chartType);
  // Theme — fall back to 'dark' (Carta default) when omitted in the saved
  // state. Tier 1 only carries the name; overrides are Tier 2 territory.
  const themeName = state.theme?.name ?? "dark";
  params.set("th", themeName);
  if (state.primarySymbol !== undefined) {
    params.set("s", state.primarySymbol);
  }
  return "#" + params.toString();
}

function encodeFull(state: ChartSaveState, limit: number): string {
  const json = JSON.stringify(state);
  const compressed = lzEncode(json);
  const fragment = "#z=" + compressed;
  if (fragment.length > limit) {
    throw new PermalinkTooLargeError(fragment.length, limit);
  }
  return fragment;
}

export function encodePermalink(
  ctx: PermalinkContext,
  opts: PermalinkOptions = {},
): string {
  const state = ctx.buildSaveState();
  const tier = resolveTier(opts.tier, state);
  const limit = opts.maxEncodedLength ?? DEFAULT_MAX_ENCODED_LENGTH;
  if (tier === "minimal") {
    const out = encodeMinimal(state);
    if (out.length > limit) {
      throw new PermalinkTooLargeError(out.length, limit);
    }
    if (out.length > TIER1_MAX_LENGTH) {
      // Soft cap — fail loud if a host stuffs a symbol so long it overflows
      // the documented Tier 1 200-char ceiling. The miniplan AC asserts
      // Tier 1 stays ≤ 200 chars.
      throw new PermalinkTooLargeError(
        out.length,
        TIER1_MAX_LENGTH,
        `tier-1 permalink ${String(out.length)} > ${String(TIER1_MAX_LENGTH)} chars — use tier:'full'`,
      );
    }
    return out;
  }
  return encodeFull(state, limit);
}

function stripEnvelope(input: string): string {
  // Accept `https://x.y/path#frag`, `https://x.y/path?q`, `#frag`, `?q`,
  // bare `key=value`. Fragment wins when both are present (RFC 3986).
  let raw = input;
  const hashIdx = raw.indexOf("#");
  if (hashIdx >= 0) {
    raw = raw.slice(hashIdx + 1);
  } else {
    const qIdx = raw.indexOf("?");
    if (qIdx >= 0) {
      raw = raw.slice(qIdx + 1);
    }
  }
  return raw;
}

function readPositiveFiniteNumber(s: string | null, label: string): number {
  if (s === null || s.length === 0) {
    throw new CartaSchemaError(
      `permalink: missing required field '${label}'`,
    );
  }
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new CartaSchemaError(
      `permalink: field '${label}' is not a finite number (got '${s}')`,
    );
  }
  return n;
}

function readPositiveInteger(s: string | null, label: string): number {
  const n = readPositiveFiniteNumber(s, label);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CartaSchemaError(
      `permalink: field '${label}' must be a positive integer (got '${String(s)}')`,
    );
  }
  return n;
}

function readSeriesKind(s: string | null): SeriesKind {
  if (s === null) {
    throw new CartaSchemaError("permalink: missing required field 'y'");
  }
  if (!(SERIES_KINDS as readonly string[]).includes(s)) {
    throw new CartaSchemaError(
      `permalink: chartType '${s}' is not a recognized SeriesKind`,
    );
  }
  // `SERIES_KINDS` is the source of truth; the guard above narrows.
  // Cast via `find` to dodge `as` on the public surface.
  const kind = SERIES_KINDS.find((k) => k === s);
  if (kind === undefined) {
    throw new CartaSchemaError(
      `permalink: chartType '${s}' is not a recognized SeriesKind`,
    );
  }
  return kind;
}

function readThemeName(s: string | null): "light" | "dark" | "custom" {
  if (s === null) {
    // Default to dark — matches Carta's runtime default.
    return "dark";
  }
  if (!THEME_NAMES.includes(s)) {
    throw new CartaSchemaError(
      `permalink: theme name '${s}' is not one of light|dark|custom`,
    );
  }
  if (s === "light") {
    return "light";
  }
  if (s === "dark") {
    return "dark";
  }
  return "custom";
}

function decodeMinimal(params: URLSearchParams): Partial<ChartSaveState> {
  const c = params.get("c");
  if (c !== TIER1_SCHEMA_VERSION) {
    throw new CartaSchemaError(
      `permalink: Tier 1 schemaVersion '${String(c)}' not supported (expected '${TIER1_SCHEMA_VERSION}')`,
    );
  }
  const f = readPositiveFiniteNumber(params.get("f"), "f");
  const t = readPositiveFiniteNumber(params.get("t"), "t");
  if (f >= t) {
    throw new CartaSchemaError(
      `permalink: window 'f' (${String(f)}) must be < 't' (${String(t)})`,
    );
  }
  const i = readPositiveInteger(params.get("i"), "i");
  const y = readSeriesKind(params.get("y"));
  const themeName = readThemeName(params.get("th"));
  const primaryChannelId = params.get("pc") ?? "primary";
  if (primaryChannelId.length === 0) {
    throw new CartaSchemaError("permalink: 'pc' must be a non-empty string");
  }
  const symbol = params.get("s") ?? undefined;
  // Theme.overrides intentionally omitted on Tier 1 — minimal protocol
  // doesn't carry styling. Tier 2 (lz-string) is where overrides live.
  const partial: Partial<ChartSaveState> = {
    schemaVersion: CARTA_SCHEMA_VERSION,
    window: { startTime: asTime(f), endTime: asTime(t) },
    intervalDuration: asInterval(i),
    chartType: y,
    primaryChannelId,
    theme: { name: themeName },
    ...(symbol !== undefined && symbol.length > 0
      ? { primarySymbol: symbol }
      : {}),
  };
  return partial;
}

function decodeFull(params: URLSearchParams): Partial<ChartSaveState> {
  const z = params.get("z");
  if (z === null || z.length === 0) {
    throw new CartaSchemaError("permalink: Tier 2 'z' field is empty");
  }
  const json = lzDecode(z);
  if (json === null) {
    throw new CartaSchemaError("permalink: Tier 2 decompress failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err: unknown) {
    throw new CartaSchemaError(
      `permalink: Tier 2 JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  // Run through the same pipeline as `chart.load`: migrate up to current
  // schema, then validate. This is the strongest design lever — one
  // round-trip code path keeps cycle-A coverage in force here.
  const migrated = migrate(parsed);
  if (!isChartSaveState(migrated)) {
    throw new CartaSchemaError(
      "permalink: Tier 2 payload failed schema validation post-migrate",
    );
  }
  return migrated;
}

export function decodePermalink(input: string): Partial<ChartSaveState> {
  if (typeof input !== "string") {
    throw new CartaSchemaError("permalink: input must be a string");
  }
  const fragment = stripEnvelope(input);
  if (fragment.length === 0) {
    throw new CartaSchemaError("permalink: empty fragment");
  }
  const params = new URLSearchParams(fragment);
  if (params.has("z")) {
    return decodeFull(params);
  }
  return decodeMinimal(params);
}
