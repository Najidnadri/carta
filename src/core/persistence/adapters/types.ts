/**
 * Phase 15 Cycle C — `ChartStorageAdapter` interface + supporting types.
 *
 * Adapters are decoupled from the chart instance — the host calls
 * `chart.save()` / `chart.exportPNG()` first, then hands the resulting
 * state + thumbnail Blob to `adapter.saveChart({...})`. This keeps adapters
 * trivially testable and lets a host swap backends (localStorage <->
 * IndexedDB <-> REST shell) without re-plumbing the chart.
 *
 * `saveChart` returns the full `ChartMetadata` (not a bare id) so a UI
 * can refresh its catalog row after save without a follow-up `listCharts()`.
 */

import type { ChartSaveState } from "../types.js";

export type ChartId = string & { readonly __brand: "ChartId" };
export type TemplateId = string & { readonly __brand: "TemplateId" };

/**
 * Public metadata row for a saved chart. Adapters stamp `createdAt` /
 * `modifiedAt` themselves (host-clock authority is the adapter's call).
 * `bytes` is the *approximate* on-disk size of the serialized state —
 * catalog UIs use it for "you're at 4.2 MB of 5 MB" warnings.
 */
export interface ChartMetadata {
  readonly id: ChartId;
  readonly name: string;
  readonly symbol?: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly thumbnailUrl?: string;
  readonly bytes: number;
}

/**
 * Metadata row for a saved template. Templates are like charts but without
 * the symbol/data binding — pure look-and-feel snapshots a host can paste
 * onto any chart.
 */
export interface ChartTemplateMetadata {
  readonly id: TemplateId;
  readonly name: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/**
 * Input for `adapter.saveChart`. `thumbnail` is a `Blob` (PNG / WEBP) — the
 * adapter decides how to persist it (IDB stores the Blob; localStorage
 * converts to data URL on the way in). Hosts that don't want a thumbnail
 * simply omit the field.
 */
export interface SaveChartInput {
  readonly id?: ChartId;
  readonly name: string;
  readonly state: ChartSaveState;
  readonly thumbnail?: Blob;
  readonly symbol?: string;
}

export interface SaveTemplateInput {
  readonly id?: TemplateId;
  readonly name: string;
  readonly state: ChartSaveState;
}

/**
 * Storage backend for named chart layouts. All methods are async — even
 * `listCharts` on localStorage — so a host can swap implementations
 * (REST, IndexedDB, in-memory) without touching call sites.
 *
 * Template ops are optional. An adapter that omits them advertises a
 * "charts-only" feature surface; hosts should feature-detect via
 * `typeof adapter.listTemplates === 'function'`.
 */
export interface ChartStorageAdapter {
  listCharts(): Promise<readonly ChartMetadata[]>;
  getChart(id: ChartId): Promise<{ readonly meta: ChartMetadata; readonly state: ChartSaveState } | null>;
  saveChart(input: SaveChartInput): Promise<ChartMetadata>;
  removeChart(id: ChartId): Promise<void>;
  renameChart(id: ChartId, name: string): Promise<ChartMetadata>;

  listTemplates?: () => Promise<readonly ChartTemplateMetadata[]>;
  saveTemplate?: (input: SaveTemplateInput) => Promise<ChartTemplateMetadata>;
  loadTemplate?: (id: TemplateId) => Promise<ChartSaveState | null>;
  removeTemplate?: (id: TemplateId) => Promise<void>;
}

/**
 * Adapter-side error. Codes:
 * - `'QUOTA'`     — backend ran out of room (localStorage 5 MB, IDB quota).
 * - `'NOT_FOUND'` — id doesn't exist.
 * - `'IO'`        — generic backend failure (IDB transaction abort, etc.).
 * - `'UNAVAILABLE'`  — backend isn't usable in this runtime (Safari Private
 *                     mode, missing `indexedDB`, `crypto.randomUUID`, etc.).
 * - `'STALE_SCHEMA'` — another tab opened a newer DB version mid-session.
 */
export type CartaStorageErrorCode =
  | "QUOTA"
  | "NOT_FOUND"
  | "IO"
  | "UNAVAILABLE"
  | "STALE_SCHEMA";

export class CartaStorageError extends Error {
  override readonly name = "CartaStorageError";
  readonly code: CartaStorageErrorCode;
  override readonly cause?: unknown;
  constructor(code: CartaStorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Internal helper: detect a localStorage quota error across browsers.
 * Names differ — standard `QuotaExceededError`, legacy WebKit
 * `QUOTA_EXCEEDED_ERR`, Firefox `NS_ERROR_DOM_QUOTA_REACHED`.
 */
export function isQuotaError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  if (typeof name !== "string") {
    return false;
  }
  return (
    name === "QuotaExceededError" ||
    name === "QUOTA_EXCEEDED_ERR" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED"
  );
}

/**
 * Internal helper: mint a random id without a third-party dep. Uses
 * `crypto.randomUUID` when available, falls back to `getRandomValues` —
 * never `Math.random` since adapter ids are cross-tab unique-ish keys.
 */
export function mintId<T extends string>(): T {
  const c: Crypto | undefined =
    typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (c !== undefined && typeof c.randomUUID === "function") {
    return c.randomUUID() as T;
  }
  if (c !== undefined && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    // RFC 4122 v4 dressing — bits 6/7 of byte 8 = '10', nibble of byte 6 = '4'.
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
    }
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}` as T;
  }
  throw new CartaStorageError("UNAVAILABLE", "crypto.randomUUID / getRandomValues unavailable in this runtime");
}
