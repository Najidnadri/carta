/**
 * Phase 15 Cycle C — `localStorageAdapter()` reference impl.
 *
 * Layout (UTF-16 string store; ~5 MB cap on most browsers):
 *   ${prefix}.index        → JSON `ChartMetadata[]` (catalog row list).
 *   ${prefix}.chart.${id}  → JSON `ChartSaveState`.
 *
 * Thumbnails are converted to data URLs at write time and stored on the
 * metadata row (inflates writes ~33%, but localStorage is JSON-only
 * anyway — Blobs would have to be serialized somehow). For larger
 * catalogs use `indexedDbAdapter()` instead.
 *
 * Quota errors are caught by name (cross-browser), wrapped in
 * `CartaStorageError('QUOTA')`, and rethrown. No LRU eviction — the
 * adapter never deletes data the host did not explicitly remove.
 *
 * Construction-time probe (`setItem('__carta_probe', '1')` then
 * `removeItem`) detects Safari Private Browsing (quota = 0) and throws
 * `CartaStorageError('UNAVAILABLE')` synchronously. Fail-loud is the
 * intended pattern.
 */

import type { ChartSaveState } from "../types.js";
import {
  CartaStorageError,
  isQuotaError,
  mintId,
  type ChartId,
  type ChartMetadata,
  type ChartStorageAdapter,
  type ChartTemplateMetadata,
  type SaveTemplateInput,
  type TemplateId,
} from "./types.js";

export interface LocalStorageAdapterOptions {
  /** Storage backend. Defaults to `globalThis.localStorage`. Override in tests. */
  readonly storage?: Storage;
  /** Key namespace. Defaults to `"carta"`. */
  readonly prefix?: string;
  /** Whether template ops are exposed on the returned adapter. Defaults to `true`. */
  readonly enableTemplates?: boolean;
  /** Logger for non-fatal warnings (corrupt index recovery). */
  readonly logger?: { warn(msg: string, ...args: readonly unknown[]): void };
}

interface RawIndex {
  readonly charts: readonly ChartMetadata[];
  readonly templates: readonly ChartTemplateMetadata[];
}

const DEFAULT_PREFIX = "carta";
const PROBE_KEY = "__carta_probe";
const NOOP_LOGGER = { warn(): void { /* noop */ } };

export function localStorageAdapter(opts: LocalStorageAdapterOptions = {}): ChartStorageAdapter {
  const initial = opts.storage ?? (typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : undefined);
  if (initial === undefined) {
    throw new CartaStorageError("UNAVAILABLE", "localStorage is not available in this runtime");
  }
  const storage: Storage = initial;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const enableTemplates = opts.enableTemplates !== false;
  const logger = opts.logger ?? NOOP_LOGGER;

  // Construction-time probe — Safari Private Browsing throws on the first
  // setItem byte.
  try {
    storage.setItem(PROBE_KEY, "1");
    storage.removeItem(PROBE_KEY);
  } catch (err: unknown) {
    if (isQuotaError(err)) {
      throw new CartaStorageError("UNAVAILABLE", "localStorage is read-only (likely Safari Private Browsing)", err);
    }
    throw new CartaStorageError("UNAVAILABLE", "localStorage probe failed", err);
  }

  const indexKey = `${prefix}.index`;
  const chartKey = (id: ChartId): string => `${prefix}.chart.${id}`;
  const templateKey = (id: TemplateId): string => `${prefix}.template.${id}`;

  function readIndex(): RawIndex {
    const raw = storage.getItem(indexKey);
    if (raw === null) {
      return { charts: [], templates: [] };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        logger.warn(`[carta] localStorageAdapter: ${indexKey} is corrupt; treating catalog as empty`);
        return { charts: [], templates: [] };
      }
      const obj = parsed as { charts?: unknown; templates?: unknown };
      const charts = Array.isArray(obj.charts) ? (obj.charts as readonly ChartMetadata[]) : [];
      const templates = Array.isArray(obj.templates)
        ? (obj.templates as readonly ChartTemplateMetadata[])
        : [];
      return { charts, templates };
    } catch (err: unknown) {
      logger.warn(`[carta] localStorageAdapter: ${indexKey} JSON parse failed; treating catalog as empty`, err);
      return { charts: [], templates: [] };
    }
  }

  function writeIndex(next: RawIndex): void {
    const serialized = JSON.stringify(next);
    try {
      storage.setItem(indexKey, serialized);
    } catch (err: unknown) {
      if (isQuotaError(err)) {
        throw new CartaStorageError("QUOTA", "localStorage quota exceeded writing catalog index", err);
      }
      throw new CartaStorageError("IO", "localStorage index write failed", err);
    }
  }

  function writeChartBlob(id: ChartId, state: ChartSaveState): number {
    const serialized = JSON.stringify(state);
    try {
      storage.setItem(chartKey(id), serialized);
    } catch (err: unknown) {
      if (isQuotaError(err)) {
        throw new CartaStorageError("QUOTA", "localStorage quota exceeded writing chart state", err);
      }
      throw new CartaStorageError("IO", "localStorage chart write failed", err);
    }
    return serialized.length;
  }

  async function blobToDataUrl(blob: Blob): Promise<string> {
    if (typeof FileReader === "undefined") {
      // Test environments without FileReader: bail to no-thumbnail rather than crash.
      throw new CartaStorageError("IO", "FileReader unavailable; cannot encode thumbnail to data URL");
    }
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (): void => {
        const r = reader.result;
        if (typeof r === "string") {
          resolve(r);
        } else {
          reject(new CartaStorageError("IO", "FileReader returned non-string result"));
        }
      };
      reader.onerror = (): void => {
        reject(new CartaStorageError("IO", "FileReader failed reading thumbnail Blob", reader.error));
      };
      reader.readAsDataURL(blob);
    });
  }

  function sortByModifiedDesc<T extends { readonly modifiedAt: string }>(rows: readonly T[]): readonly T[] {
    return [...rows].sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
  }

  const adapter: ChartStorageAdapter = {
    listCharts: () => {
      const index = readIndex();
      return Promise.resolve(sortByModifiedDesc(index.charts));
    },

    getChart: (id) => {
      const index = readIndex();
      const meta = index.charts.find((m) => m.id === id);
      if (meta === undefined) {
        return Promise.resolve(null);
      }
      const raw = storage.getItem(chartKey(id));
      if (raw === null) {
        // Orphan in the index — remove it to self-heal.
        writeIndex({ charts: index.charts.filter((m) => m.id !== id), templates: index.templates });
        return Promise.resolve(null);
      }
      let state: ChartSaveState;
      try {
        state = JSON.parse(raw) as ChartSaveState;
      } catch (err: unknown) {
        logger.warn(`[carta] localStorageAdapter: chart ${id} JSON parse failed`, err);
        return Promise.resolve(null);
      }
      return Promise.resolve({ meta, state });
    },

    saveChart: async (input) => {
      const id: ChartId = input.id ?? mintId<ChartId>();
      const now = new Date().toISOString();
      const index = readIndex();
      const existing = index.charts.find((m) => m.id === id);
      let thumbnailUrl: string | undefined;
      if (input.thumbnail !== undefined) {
        thumbnailUrl = await blobToDataUrl(input.thumbnail);
      } else if (existing !== undefined) {
        thumbnailUrl = existing.thumbnailUrl;
      }
      // Snapshot the prior blob so we can roll back on an index-write
      // failure (typically QUOTA). Without this, an index-write QUOTA
      // after a successful blob-write would leak the new blob forever
      // — no `getChart` path can reach it, no `listCharts` row points
      // at it (test matrix S15C-LS-A-021).
      const priorBlob = existing !== undefined ? storage.getItem(chartKey(id)) : null;
      const bytes = writeChartBlob(id, input.state);
      const meta: ChartMetadata = {
        id,
        name: input.name,
        ...(input.symbol !== undefined ? { symbol: input.symbol } : existing?.symbol !== undefined ? { symbol: existing.symbol } : {}),
        createdAt: existing?.createdAt ?? now,
        modifiedAt: now,
        ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
        bytes,
      };
      const nextCharts = existing
        ? index.charts.map((m) => (m.id === id ? meta : m))
        : [...index.charts, meta];
      try {
        writeIndex({ charts: nextCharts, templates: index.templates });
      } catch (err: unknown) {
        try {
          if (priorBlob === null) {
            storage.removeItem(chartKey(id));
          } else {
            storage.setItem(chartKey(id), priorBlob);
          }
        } catch { /* rollback best-effort; storage may be wedged */ }
        throw err;
      }
      return meta;
    },

    removeChart: (id) => {
      const index = readIndex();
      if (!index.charts.some((m) => m.id === id)) {
        return Promise.reject(new CartaStorageError("NOT_FOUND", `chart ${id} not found`));
      }
      writeIndex({ charts: index.charts.filter((m) => m.id !== id), templates: index.templates });
      try {
        storage.removeItem(chartKey(id));
      } catch (err: unknown) {
        return Promise.reject(new CartaStorageError("IO", "localStorage chart remove failed", err));
      }
      return Promise.resolve();
    },

    renameChart: (id, name) => {
      const index = readIndex();
      const existing = index.charts.find((m) => m.id === id);
      if (existing === undefined) {
        return Promise.reject(new CartaStorageError("NOT_FOUND", `chart ${id} not found`));
      }
      const next: ChartMetadata = {
        ...existing,
        name,
        modifiedAt: new Date().toISOString(),
      };
      writeIndex({
        charts: index.charts.map((m) => (m.id === id ? next : m)),
        templates: index.templates,
      });
      return Promise.resolve(next);
    },
  };

  if (enableTemplates) {
    adapter.listTemplates = () => {
      const index = readIndex();
      return Promise.resolve(sortByModifiedDesc(index.templates));
    };
    adapter.saveTemplate = (input: SaveTemplateInput) => {
      const id: TemplateId = input.id ?? mintId<TemplateId>();
      const now = new Date().toISOString();
      const index = readIndex();
      const existing = index.templates.find((m) => m.id === id);
      try {
        storage.setItem(templateKey(id), JSON.stringify(input.state));
      } catch (err: unknown) {
        if (isQuotaError(err)) {
          return Promise.reject(new CartaStorageError("QUOTA", "localStorage quota exceeded writing template", err));
        }
        return Promise.reject(new CartaStorageError("IO", "localStorage template write failed", err));
      }
      const meta: ChartTemplateMetadata = {
        id,
        name: input.name,
        createdAt: existing?.createdAt ?? now,
        modifiedAt: now,
      };
      const nextTemplates = existing
        ? index.templates.map((m) => (m.id === id ? meta : m))
        : [...index.templates, meta];
      writeIndex({ charts: index.charts, templates: nextTemplates });
      return Promise.resolve(meta);
    };
    adapter.loadTemplate = (id: TemplateId) => {
      const raw = storage.getItem(templateKey(id));
      if (raw === null) {
        return Promise.resolve(null);
      }
      try {
        return Promise.resolve(JSON.parse(raw) as ChartSaveState);
      } catch (err: unknown) {
        logger.warn(`[carta] localStorageAdapter: template ${id} JSON parse failed`, err);
        return Promise.resolve(null);
      }
    };
    adapter.removeTemplate = (id: TemplateId) => {
      const index = readIndex();
      if (!index.templates.some((m) => m.id === id)) {
        return Promise.reject(new CartaStorageError("NOT_FOUND", `template ${id} not found`));
      }
      writeIndex({
        charts: index.charts,
        templates: index.templates.filter((m) => m.id !== id),
      });
      try {
        storage.removeItem(templateKey(id));
      } catch (err: unknown) {
        return Promise.reject(new CartaStorageError("IO", "localStorage template remove failed", err));
      }
      return Promise.resolve();
    };
  }

  return adapter;
}
