/**
 * Phase 15 Cycle C — `indexedDbAdapter()` reference impl.
 *
 * Schema v1:
 *   DB `${dbName}` (default `"carta-charts"`).
 *   Store `charts`, `keyPath: 'id'`, indexes `idx_modifiedAt` + `idx_symbol`.
 *   Store `templates` (only when `enableTemplates: true`), `keyPath: 'id'`,
 *     index `idx_modifiedAt`.
 *
 * Connection strategy: lazy-open + 30 s idle keep-alive. The first op
 * opens the DB; each op resets a `setTimeout` that closes it. This
 * releases the `versionchange` lock so other tabs can upgrade. The
 * `onversionchange` handler closes our connection immediately if another
 * tab triggers an upgrade — the next op will reopen.
 *
 * Promise plumbing lives in `idbPromise.ts`. We never `await` between two
 * `objectStore.X()` calls in the same transaction (MDN — Safari is strict).
 */

import type { ChartSaveState } from "../types.js";
import {
  CartaStorageError,
  mintId,
  type ChartId,
  type ChartMetadata,
  type ChartStorageAdapter,
  type ChartTemplateMetadata,
  type SaveChartInput,
  type SaveTemplateInput,
  type TemplateId,
} from "./types.js";
import { reqAsPromise, txAsPromise } from "./idbPromise.js";

export interface IndexedDbAdapterOptions {
  /** DB name. Defaults to `"carta-charts"`. */
  readonly dbName?: string;
  /** Whether to create the `templates` store on first open. Defaults to `false`. */
  readonly enableTemplates?: boolean;
  /** Idle ms before the connection closes (releases versionchange lock). Default 30_000. */
  readonly idleCloseMs?: number;
  /** Override `globalThis.indexedDB`. For tests + Node `fake-indexeddb`. */
  readonly indexedDB?: IDBFactory;
  /** Logger for non-fatal warnings. */
  readonly logger?: { warn(msg: string, ...args: readonly unknown[]): void };
}

interface ChartRow {
  readonly id: ChartId;
  readonly meta: ChartMetadata;
  readonly state: ChartSaveState;
  readonly thumbnail?: Blob;
}

interface TemplateRow {
  readonly id: TemplateId;
  readonly meta: ChartTemplateMetadata;
  readonly state: ChartSaveState;
}

const DEFAULT_DB_NAME = "carta-charts";
const DEFAULT_IDLE_CLOSE_MS = 30_000;
const SCHEMA_VERSION = 1;
const STORE_CHARTS = "charts";
const STORE_TEMPLATES = "templates";
const IDX_MODIFIED_AT = "idx_modifiedAt";
const IDX_SYMBOL = "idx_symbol";
const NOOP_LOGGER = { warn(): void { /* noop */ } };

export function indexedDbAdapter(opts: IndexedDbAdapterOptions = {}): ChartStorageAdapter {
  const dbName = opts.dbName ?? DEFAULT_DB_NAME;
  const enableTemplates = opts.enableTemplates === true;
  const idleCloseMs = opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const initialFactory =
    opts.indexedDB ?? (typeof globalThis.indexedDB !== "undefined" ? globalThis.indexedDB : undefined);
  if (initialFactory === undefined) {
    throw new CartaStorageError("UNAVAILABLE", "indexedDB is not available in this runtime");
  }
  const idbFactory: IDBFactory = initialFactory;
  const logger = opts.logger ?? NOOP_LOGGER;

  let db: IDBDatabase | null = null;
  let staleSchema = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (db !== null) {
        try { db.close(); } catch { /* ignore */ }
        db = null;
      }
    }, idleCloseMs);
  }

  async function openDb(): Promise<IDBDatabase> {
    if (staleSchema) {
      throw new CartaStorageError(
        "STALE_SCHEMA",
        "another tab upgraded the IDB schema; reload to continue",
      );
    }
    if (db !== null) {
      resetIdleTimer();
      return db;
    }
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idbFactory.open(dbName, SCHEMA_VERSION);
      req.addEventListener("upgradeneeded", () => {
        const upgrading = req.result;
        if (!upgrading.objectStoreNames.contains(STORE_CHARTS)) {
          const store = upgrading.createObjectStore(STORE_CHARTS, { keyPath: "id" });
          store.createIndex(IDX_MODIFIED_AT, "meta.modifiedAt", { unique: false });
          store.createIndex(IDX_SYMBOL, "meta.symbol", { unique: false });
        }
        if (enableTemplates && !upgrading.objectStoreNames.contains(STORE_TEMPLATES)) {
          const store = upgrading.createObjectStore(STORE_TEMPLATES, { keyPath: "id" });
          store.createIndex(IDX_MODIFIED_AT, "meta.modifiedAt", { unique: false });
        }
      });
      req.addEventListener("success", () => { resolve(req.result); });
      req.addEventListener("error", () => {
        reject(new CartaStorageError("UNAVAILABLE", "indexedDB.open failed", req.error));
      });
      req.addEventListener("blocked", () => {
        // Another tab holds an open connection at a different version.
        // Reject with a hint; the caller can retry after the other tab closes.
        reject(new CartaStorageError("UNAVAILABLE", "indexedDB.open blocked by another tab"));
      });
    });
    opened.addEventListener("versionchange", () => {
      // Another tab is upgrading. Close immediately so the upgrade proceeds.
      try { opened.close(); } catch { /* ignore */ }
      if (db === opened) {
        db = null;
        staleSchema = true;
      }
      logger.warn(`[carta] indexedDbAdapter: ${dbName} versionchange — connection closed; reload to continue`);
    });
    opened.addEventListener("close", () => {
      if (db === opened) {
        db = null;
      }
    });
    db = opened;
    resetIdleTimer();
    return opened;
  }

  function metaFromRow(row: ChartRow): ChartMetadata {
    // Re-derive bytes from a quick stringify length so the row's bytes
    // field tracks the on-disk shape. Cheap relative to a save itself.
    const bytes = JSON.stringify(row.state).length;
    return { ...row.meta, bytes };
  }

  function blobToThumbnailUrl(blob: Blob): string {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      try {
        return URL.createObjectURL(blob);
      } catch {
        // Some test environments structural-clone the Blob into a plain
        // Object on round-trip; URL.createObjectURL then throws. Fall
        // through to empty — the catalog row still works without a thumb.
        return "";
      }
    }
    return "";
  }

  const adapter: ChartStorageAdapter = {
    listCharts: async () => {
      const database = await openDb();
      const tx = database.transaction([STORE_CHARTS], "readonly");
      const store = tx.objectStore(STORE_CHARTS);
      const idx = store.index(IDX_MODIFIED_AT);
      const rows = await reqAsPromise<unknown[]>(idx.getAll());
      await txAsPromise(tx);
      if (!Array.isArray(rows)) {
        return [];
      }
      const out: ChartMetadata[] = [];
      for (const r of rows) {
        if (r === null || typeof r !== "object") { continue; }
        const row = r as ChartRow;
        const thumbnailUrl =
          row.thumbnail !== undefined ? blobToThumbnailUrl(row.thumbnail) : undefined;
        out.push({
          ...metaFromRow(row),
          ...(thumbnailUrl !== undefined && thumbnailUrl.length > 0 ? { thumbnailUrl } : {}),
        });
      }
      // Index returns ascending modifiedAt; we want newest first.
      out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
      return out;
    },

    getChart: async (id) => {
      const database = await openDb();
      const tx = database.transaction([STORE_CHARTS], "readonly");
      const store = tx.objectStore(STORE_CHARTS);
      const raw = await reqAsPromise<unknown>(store.get(id));
      await txAsPromise(tx);
      if (raw === null || typeof raw !== "object") {
        return null;
      }
      const row = raw as ChartRow;
      const thumbnailUrl =
        row.thumbnail !== undefined ? blobToThumbnailUrl(row.thumbnail) : undefined;
      const meta: ChartMetadata = {
        ...metaFromRow(row),
        ...(thumbnailUrl !== undefined && thumbnailUrl.length > 0 ? { thumbnailUrl } : {}),
      };
      return { meta, state: row.state };
    },

    saveChart: async (input: SaveChartInput) => {
      const id: ChartId = input.id ?? mintId<ChartId>();
      const now = new Date().toISOString();
      const database = await openDb();
      const tx = database.transaction([STORE_CHARTS], "readwrite");
      const store = tx.objectStore(STORE_CHARTS);
      const existing = (await reqAsPromise<unknown>(store.get(id))) as ChartRow | undefined;
      let bytes: number;
      try {
        bytes = JSON.stringify(input.state).length;
      } catch (err: unknown) {
        // Circular references in `input.state` blow up JSON.stringify.
        // Wrap rather than letting a raw TypeError escape the adapter
        // contract (test matrix S15C-IDB-A-030).
        throw new CartaStorageError("IO", "indexedDB save: state is not JSON-serializable", err);
      }
      const meta: ChartMetadata = {
        id,
        name: input.name,
        ...(input.symbol !== undefined
          ? { symbol: input.symbol }
          : existing?.meta.symbol !== undefined
            ? { symbol: existing.meta.symbol }
            : {}),
        createdAt: existing?.meta.createdAt ?? now,
        modifiedAt: now,
        bytes,
      };
      const row: ChartRow = {
        id,
        meta,
        state: input.state,
        ...(input.thumbnail !== undefined
          ? { thumbnail: input.thumbnail }
          : existing?.thumbnail !== undefined
            ? { thumbnail: existing.thumbnail }
            : {}),
      };
      try {
        await reqAsPromise(store.put(row));
      } catch (err: unknown) {
        const name = (err as { name?: string } | null)?.name;
        if (name === "QuotaExceededError") {
          await txAsPromise(tx).catch(() => {});
          throw new CartaStorageError("QUOTA", "indexedDB quota exceeded writing chart", err);
        }
        throw new CartaStorageError("IO", "indexedDB chart write failed", err);
      }
      await txAsPromise(tx);
      const thumbnailUrl =
        row.thumbnail !== undefined ? blobToThumbnailUrl(row.thumbnail) : undefined;
      return {
        ...meta,
        ...(thumbnailUrl !== undefined && thumbnailUrl.length > 0 ? { thumbnailUrl } : {}),
      };
    },

    removeChart: async (id) => {
      const database = await openDb();
      const tx = database.transaction([STORE_CHARTS], "readwrite");
      const store = tx.objectStore(STORE_CHARTS);
      const existing = await reqAsPromise<unknown>(store.get(id));
      if (existing === undefined || existing === null) {
        await txAsPromise(tx).catch(() => {});
        throw new CartaStorageError("NOT_FOUND", `chart ${id} not found`);
      }
      await reqAsPromise(store.delete(id));
      await txAsPromise(tx);
    },

    renameChart: async (id, name) => {
      const database = await openDb();
      const tx = database.transaction([STORE_CHARTS], "readwrite");
      const store = tx.objectStore(STORE_CHARTS);
      const existing = (await reqAsPromise<unknown>(store.get(id))) as ChartRow | undefined;
      if (existing === undefined) {
        await txAsPromise(tx).catch(() => {});
        throw new CartaStorageError("NOT_FOUND", `chart ${id} not found`);
      }
      const nextMeta: ChartMetadata = {
        ...existing.meta,
        name,
        modifiedAt: new Date().toISOString(),
      };
      const nextRow: ChartRow = { ...existing, meta: nextMeta };
      await reqAsPromise(store.put(nextRow));
      await txAsPromise(tx);
      const thumbnailUrl =
        nextRow.thumbnail !== undefined ? blobToThumbnailUrl(nextRow.thumbnail) : undefined;
      return {
        ...nextMeta,
        ...(thumbnailUrl !== undefined && thumbnailUrl.length > 0 ? { thumbnailUrl } : {}),
      };
    },
  };

  if (enableTemplates) {
    adapter.listTemplates = async () => {
      const database = await openDb();
      const tx = database.transaction([STORE_TEMPLATES], "readonly");
      const store = tx.objectStore(STORE_TEMPLATES);
      const idx = store.index(IDX_MODIFIED_AT);
      const rows = await reqAsPromise<unknown[]>(idx.getAll());
      await txAsPromise(tx);
      if (!Array.isArray(rows)) { return []; }
      const out: ChartTemplateMetadata[] = [];
      for (const r of rows) {
        if (r === null || typeof r !== "object") { continue; }
        out.push((r as TemplateRow).meta);
      }
      out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
      return out;
    };
    adapter.saveTemplate = async (input: SaveTemplateInput) => {
      const id: TemplateId = input.id ?? mintId<TemplateId>();
      const now = new Date().toISOString();
      const database = await openDb();
      const tx = database.transaction([STORE_TEMPLATES], "readwrite");
      const store = tx.objectStore(STORE_TEMPLATES);
      const existing = (await reqAsPromise<unknown>(store.get(id))) as TemplateRow | undefined;
      const meta: ChartTemplateMetadata = {
        id,
        name: input.name,
        createdAt: existing?.meta.createdAt ?? now,
        modifiedAt: now,
      };
      const row: TemplateRow = { id, meta, state: input.state };
      try {
        await reqAsPromise(store.put(row));
      } catch (err: unknown) {
        const name = (err as { name?: string } | null)?.name;
        if (name === "QuotaExceededError") {
          await txAsPromise(tx).catch(() => {});
          throw new CartaStorageError("QUOTA", "indexedDB quota exceeded writing template", err);
        }
        throw new CartaStorageError("IO", "indexedDB template write failed", err);
      }
      await txAsPromise(tx);
      return meta;
    };
    adapter.loadTemplate = async (id: TemplateId) => {
      const database = await openDb();
      const tx = database.transaction([STORE_TEMPLATES], "readonly");
      const store = tx.objectStore(STORE_TEMPLATES);
      const raw = await reqAsPromise<unknown>(store.get(id));
      await txAsPromise(tx);
      if (raw === null || typeof raw !== "object") {
        return null;
      }
      return (raw as TemplateRow).state;
    };
    adapter.removeTemplate = async (id: TemplateId) => {
      const database = await openDb();
      const tx = database.transaction([STORE_TEMPLATES], "readwrite");
      const store = tx.objectStore(STORE_TEMPLATES);
      const existing = await reqAsPromise<unknown>(store.get(id));
      if (existing === undefined || existing === null) {
        await txAsPromise(tx).catch(() => {});
        throw new CartaStorageError("NOT_FOUND", `template ${id} not found`);
      }
      await reqAsPromise(store.delete(id));
      await txAsPromise(tx);
    };
  }

  return adapter;
}
