/**
 * Phase 15 Cycle B — pure CSV encoder. The trader hits "Export CSV" 5× a
 * day to paste candles into Excel or feed them into a backtester. We pull
 * from the chart's cache (canonical, deduped, sorted) and format with
 * locale-aware decimal/delimiter knobs, UTF-8 BOM, and CRLF line endings —
 * the combination Excel needs to render columns correctly on Windows + Mac
 * without "Text Import Wizard" intervention.
 *
 * Failure modes are loud: unknown channel, marker channel, decimal ≡
 * delimiter, precision out of range — all throw `ExportError` synchronously
 * so the host sees the bug at click-time, not when the user opens the file
 * and sees garbage.
 *
 * Gap detection: when the requested range straddles cache gaps, the encoder
 * emits a one-shot `'export:partial-data'` event carrying the gap ranges.
 * Phantom rows are NOT synthesized — the cache is the source of truth.
 */

import type {
  Channel,
  ChannelKind,
  DataRecord,
  ExportPartialDataPayload,
  Interval,
  OhlcRecord,
  PointRecord,
  Range,
  Time,
} from "../../types.js";
import { asInterval, asTime } from "../../types.js";
import { ExportError } from "./types.js";
import type { CsvExportOptions, CsvTimeFormat } from "./types.js";

const UTF8_BOM = "﻿";
const DEFAULT_DELIMITER = ",";
const DEFAULT_DECIMAL = ".";
const DEFAULT_LINE_ENDING = "\r\n";
const DEFAULT_PRECISION = 2;
const MAX_PRECISION = 12;

type EmitPartial = (payload: ExportPartialDataPayload) => void;

/**
 * Friend interface — read-only handle into the chart's data layer plus
 * the visible window. Mirrors the `SaveContext` pattern in `save.ts` so
 * CSV is fully unit-testable without a real chart instance.
 */
export interface CsvExportContext {
  readonly window: { startTime: Time; endTime: Time };
  readonly intervalDuration: Interval;
  readonly defaultChannelId: string;
  readonly getChannel: (id: string) => Channel | undefined;
  readonly recordsInRange: (
    channelId: string,
    intervalDuration: number,
    start: number,
    end: number,
  ) => readonly DataRecord[];
  readonly missingRanges: (
    channelId: string,
    intervalDuration: number,
    start: number,
    end: number,
  ) => readonly Range[];
  readonly emitPartialData: EmitPartial;
}

interface ResolvedCsvOptions {
  readonly channelId: string;
  readonly start: number;
  readonly end: number;
  readonly timeFormat: CsvTimeFormat;
  readonly decimal: "." | ",";
  readonly delimiter: "," | ";" | "\t";
  readonly precision: number;
  readonly includeBOM: boolean;
  readonly lineEnding: "\r\n" | "\n";
}

function resolveOptions(
  ctx: CsvExportContext,
  opts: CsvExportOptions,
): ResolvedCsvOptions {
  const channelId = opts.channelId ?? ctx.defaultChannelId;
  const start = opts.range?.startTime ?? Number(ctx.window.startTime);
  const end = opts.range?.endTime ?? Number(ctx.window.endTime);
  const timeFormat = opts.timeFormat ?? "iso";
  const decimal = opts.decimal ?? DEFAULT_DECIMAL;
  const delimiter = opts.delimiter ?? DEFAULT_DELIMITER;
  const precision = opts.precision ?? DEFAULT_PRECISION;
  const includeBOM = opts.includeBOM ?? true;
  const lineEnding = opts.lineEnding ?? DEFAULT_LINE_ENDING;
  return {
    channelId,
    start,
    end,
    timeFormat,
    decimal,
    delimiter,
    precision,
    includeBOM,
    lineEnding,
  };
}

function validateOptions(resolved: ResolvedCsvOptions): void {
  if (resolved.delimiter === resolved.decimal) {
    throw new ExportError(
      "GENERIC",
      `delimiter (${resolved.delimiter}) must differ from decimal (${resolved.decimal})`,
    );
  }
  if (
    !Number.isInteger(resolved.precision) ||
    resolved.precision < 0 ||
    resolved.precision > MAX_PRECISION
  ) {
    throw new ExportError(
      "GENERIC",
      `precision must be an integer in [0, ${String(MAX_PRECISION)}], got ${String(resolved.precision)}`,
    );
  }
}

function headerFor(kind: ChannelKind, delimiter: string): string {
  if (kind === "ohlc") {
    return ["time", "open", "high", "low", "close", "volume"].join(delimiter);
  }
  // `point`. Marker channels are rejected before reaching here.
  return ["time", "value"].join(delimiter);
}

function formatTime(t: number, fmt: CsvTimeFormat): string {
  if (fmt === "epoch-ms") {
    return String(t);
  }
  // ISO 8601, always UTC `Z`. Excel imports as text + sorts correctly.
  return new Date(t).toISOString();
}

function formatNumber(
  value: number | undefined | null,
  precision: number,
  decimal: "." | ",",
): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (!Number.isFinite(value)) {
    return "";
  }
  const s = value.toFixed(precision);
  if (decimal === ",") {
    return s.replace(".", ",");
  }
  return s;
}

function rowForOhlc(
  rec: OhlcRecord,
  resolved: ResolvedCsvOptions,
): string {
  const { precision: p, decimal, delimiter, timeFormat } = resolved;
  const time = formatTime(Number(rec.time), timeFormat);
  const open = formatNumber(rec.open, p, decimal);
  const high = formatNumber(rec.high, p, decimal);
  const low = formatNumber(rec.low, p, decimal);
  const close = formatNumber(rec.close, p, decimal);
  const volume =
    rec.volume === undefined ? "" : formatNumber(rec.volume, p, decimal);
  return [time, open, high, low, close, volume].join(delimiter);
}

function rowForPoint(
  rec: PointRecord,
  resolved: ResolvedCsvOptions,
): string {
  const time = formatTime(Number(rec.time), resolved.timeFormat);
  const value = formatNumber(rec.value, resolved.precision, resolved.decimal);
  return [time, value].join(resolved.delimiter);
}

export function exportCsv(
  ctx: CsvExportContext,
  opts: CsvExportOptions = {},
): string {
  const resolved = resolveOptions(ctx, opts);
  validateOptions(resolved);

  const channel = ctx.getChannel(resolved.channelId);
  if (channel === undefined) {
    throw new ExportError(
      "GENERIC",
      `unknown channel '${resolved.channelId}'`,
    );
  }
  if (channel.kind === "marker") {
    throw new ExportError(
      "GENERIC",
      `marker channel '${resolved.channelId}' is not CSV-exportable`,
    );
  }

  const records = ctx.recordsInRange(
    resolved.channelId,
    Number(ctx.intervalDuration),
    resolved.start,
    resolved.end,
  );

  // Gap surfacing — emit once, with the gaps array. Phantom rows are NOT
  // synthesized; hosts that need a complete series should warm the cache
  // before export.
  const gaps = ctx.missingRanges(
    resolved.channelId,
    Number(ctx.intervalDuration),
    resolved.start,
    resolved.end,
  );
  if (gaps.length > 0) {
    ctx.emitPartialData({
      channelId: resolved.channelId,
      intervalDuration: asInterval(Number(ctx.intervalDuration)),
      range: {
        startTime: asTime(resolved.start),
        endTime: asTime(resolved.end),
      },
      gaps,
    });
  }

  const header = headerFor(channel.kind, resolved.delimiter);
  const rows: string[] = [header];
  if (channel.kind === "ohlc") {
    for (const rec of records) {
      // Per `recordMatchesKind`, the cache only stores ohlc records here.
      // Narrow via property presence — keeps a `as` cast out of the hot path.
      if ("open" in rec) {
        rows.push(rowForOhlc(rec, resolved));
      }
    }
  } else {
    for (const rec of records) {
      if ("value" in rec) {
        rows.push(rowForPoint(rec, resolved));
      }
    }
  }

  const body = rows.join(resolved.lineEnding);
  return resolved.includeBOM ? UTF8_BOM + body : body;
}
