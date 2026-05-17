/**
 * Phase 15 Cycle C — `localStorageAdapter()` tests. Uses an in-memory
 * Storage shim so we don't touch real localStorage.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { localStorageAdapter } from "./localStorage.js";
import { CartaStorageError, type ChartId } from "./types.js";
import { CARTA_SCHEMA_VERSION, type ChartSaveState } from "../types.js";
import { asInterval, asTime } from "../../../types.js";

function fakeStorage(opts: { quota?: number; throwOnSet?: boolean; throwOnProbe?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  let totalBytes = 0;
  const quota = opts.quota ?? Number.POSITIVE_INFINITY;
  let probeCount = 0;
  return {
    getItem(k: string): string | null { return map.get(k) ?? null; },
    setItem(k: string, v: string): void {
      if (opts.throwOnProbe === true && k === "__carta_probe") {
        probeCount += 1;
        const e = new Error("probe blocked") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
      if (opts.throwOnSet === true) {
        const e = new Error("quota exceeded") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
      const old = map.get(k);
      if (old !== undefined) { totalBytes -= old.length; }
      if (totalBytes + v.length > quota) {
        const e = new Error("quota exceeded") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
      totalBytes += v.length;
      map.set(k, v);
    },
    removeItem(k: string): void {
      const old = map.get(k);
      if (old !== undefined) { totalBytes -= old.length; }
      map.delete(k);
    },
    clear(): void { map.clear(); totalBytes = 0; },
    key(i: number): string | null { return Array.from(map.keys())[i] ?? null; },
    get length(): number { return map.size; },
    get _probeCount(): number { return probeCount; },
  } as Storage;
}

function sampleState(label = "sample"): ChartSaveState {
  return {
    schemaVersion: CARTA_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    window: { startTime: asTime(0), endTime: asTime(60_000) },
    intervalDuration: asInterval(60_000),
    chartType: "candle",
    primaryChannelId: label,
    series: [{ kind: "candle", channel: label, options: { channel: label } }],
  };
}

let storage: Storage;
beforeEach(() => {
  storage = fakeStorage();
});

describe("localStorageAdapter — construction", () => {
  it("throws UNAVAILABLE when storage isn't passed and globalThis.localStorage is missing", () => {
    const stash = (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { localStorage?: Storage }).localStorage;
    try {
      expect(() => localStorageAdapter()).toThrow(CartaStorageError);
    } finally {
      if (stash !== undefined) { (globalThis as { localStorage?: Storage }).localStorage = stash; }
    }
  });

  it("throws UNAVAILABLE when probe setItem throws", () => {
    const blocked = fakeStorage({ throwOnProbe: true });
    expect(() => localStorageAdapter({ storage: blocked })).toThrow(/Safari Private|probe failed|read-only/);
  });

  it("succeeds on a healthy storage", () => {
    expect(() => localStorageAdapter({ storage })).not.toThrow();
  });
});

describe("localStorageAdapter — chart CRUD", () => {
  it("lists empty on a fresh store", async () => {
    const a = localStorageAdapter({ storage });
    await expect(a.listCharts()).resolves.toEqual([]);
  });

  it("saves and retrieves a chart with name + state", async () => {
    const a = localStorageAdapter({ storage });
    const meta = await a.saveChart({ name: "AAPL daily", state: sampleState("aapl") });
    expect(meta.name).toBe("AAPL daily");
    expect(meta.id).toBeTruthy();
    expect(meta.bytes).toBeGreaterThan(0);
    expect(meta.createdAt).toBe(meta.modifiedAt);

    const row = await a.getChart(meta.id);
    expect(row).not.toBeNull();
    expect(row?.state.primaryChannelId).toBe("aapl");
  });

  it("getChart returns null for unknown id", async () => {
    const a = localStorageAdapter({ storage });
    await expect(a.getChart("nope" as ChartId)).resolves.toBeNull();
  });

  it("listCharts orders newest first by modifiedAt", async () => {
    const a = localStorageAdapter({ storage });
    const m1 = await a.saveChart({ name: "first", state: sampleState() });
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await a.saveChart({ name: "second", state: sampleState() });
    const list = await a.listCharts();
    expect(list[0]?.id).toBe(m2.id);
    expect(list[1]?.id).toBe(m1.id);
  });

  it("overwrites on save with same id, preserves createdAt", async () => {
    const a = localStorageAdapter({ storage });
    const m1 = await a.saveChart({ name: "v1", state: sampleState() });
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await a.saveChart({ id: m1.id, name: "v2", state: sampleState() });
    expect(m2.id).toBe(m1.id);
    expect(m2.name).toBe("v2");
    expect(m2.createdAt).toBe(m1.createdAt);
    expect(m2.modifiedAt >= m1.modifiedAt).toBe(true);
    const list = await a.listCharts();
    expect(list).toHaveLength(1);
  });

  it("rename updates name + modifiedAt, preserves createdAt", async () => {
    const a = localStorageAdapter({ storage });
    const m1 = await a.saveChart({ name: "old", state: sampleState() });
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await a.renameChart(m1.id, "new");
    expect(m2.name).toBe("new");
    expect(m2.createdAt).toBe(m1.createdAt);
    expect(m2.modifiedAt > m1.modifiedAt).toBe(true);
  });

  it("rename of missing id rejects with NOT_FOUND", async () => {
    const a = localStorageAdapter({ storage });
    await expect(a.renameChart("missing" as ChartId, "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("remove deletes the row", async () => {
    const a = localStorageAdapter({ storage });
    const m = await a.saveChart({ name: "rm-me", state: sampleState() });
    await a.removeChart(m.id);
    await expect(a.getChart(m.id)).resolves.toBeNull();
    await expect(a.listCharts()).resolves.toEqual([]);
  });

  it("remove of missing id rejects with NOT_FOUND", async () => {
    const a = localStorageAdapter({ storage });
    await expect(a.removeChart("ghost" as ChartId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("localStorageAdapter — quota / corruption / edge cases", () => {
  it("rolls back the chart blob when the index write fails (no orphan)", async () => {
    const a = localStorageAdapter({ storage });
    // First save succeeds.
    const m1 = await a.saveChart({ name: "v1", state: sampleState() });
    const originalBlob = storage.getItem(`carta.chart.${m1.id}`);
    expect(originalBlob).not.toBeNull();
    // Now patch setItem to throw QUOTA only when writing the index.
    const origSet = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string): void => {
      if (k === "carta.index") {
        const e = new Error("quota") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
      origSet(k, v);
    };
    let caught: unknown = null;
    try {
      await a.saveChart({ id: m1.id, name: "v2", state: { ...sampleState(), savedAt: "v2" } });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CartaStorageError);
    expect((caught as CartaStorageError).code).toBe("QUOTA");
    // Rollback restored the prior blob — no orphan, no truncated state.
    expect(storage.getItem(`carta.chart.${m1.id}`)).toBe(originalBlob);
    // Restore for other tests.
    storage.setItem = origSet;
  });

  it("rolls back to no-blob when a new-row save fails on the index write", async () => {
    const a = localStorageAdapter({ storage });
    const origSet = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string): void => {
      if (k === "carta.index") {
        const e = new Error("quota") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
      origSet(k, v);
    };
    let caught: unknown = null;
    try {
      await a.saveChart({ name: "fresh", state: sampleState() });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CartaStorageError);
    storage.setItem = origSet;
    // No chart blob should remain — count keys starting with carta.chart.
    let leakedBlobs = 0;
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k?.startsWith("carta.chart.") === true) { leakedBlobs += 1; }
    }
    expect(leakedBlobs).toBe(0);
  });

  it("maps quota error on write to CartaStorageError('QUOTA')", async () => {
    const tiny = fakeStorage({ quota: 256 });
    const a = localStorageAdapter({ storage: tiny });
    let caught: unknown = null;
    try {
      await a.saveChart({ name: "huge", state: { ...sampleState(), savedAt: "x".repeat(2000) } });
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CartaStorageError);
    expect((caught as CartaStorageError).code).toBe("QUOTA");
  });

  it("recovers from a corrupt index by treating catalog as empty + warn", async () => {
    storage.setItem("carta.index", "{not json{");
    const warns: string[] = [];
    const a = localStorageAdapter({
      storage,
      logger: { warn: (m): void => { warns.push(m); } },
    });
    await expect(a.listCharts()).resolves.toEqual([]);
    expect(warns.some((w) => w.includes("JSON parse failed"))).toBe(true);
  });

  it("self-heals orphan rows when chart blob is gone but index has it", async () => {
    const a = localStorageAdapter({ storage });
    const m = await a.saveChart({ name: "orphan", state: sampleState() });
    storage.removeItem(`carta.chart.${m.id}`);
    await expect(a.getChart(m.id)).resolves.toBeNull();
    await expect(a.listCharts()).resolves.toEqual([]);
  });

  it("supports a custom prefix", async () => {
    const a = localStorageAdapter({ storage, prefix: "tenant-7" });
    await a.saveChart({ name: "x", state: sampleState() });
    expect(storage.getItem("tenant-7.index")).not.toBeNull();
    expect(storage.getItem("carta.index")).toBeNull();
  });

  it("templates are opt-out via enableTemplates:false", () => {
    const a = localStorageAdapter({ storage, enableTemplates: false });
    expect(a.listTemplates).toBeUndefined();
    expect(a.saveTemplate).toBeUndefined();
  });

  it("preserves existing symbol when re-saving without an explicit symbol", async () => {
    const a = localStorageAdapter({ storage });
    const m1 = await a.saveChart({ name: "AAPL", state: sampleState(), symbol: "AAPL" });
    const m2 = await a.saveChart({ id: m1.id, name: "AAPL", state: sampleState() });
    expect(m2.symbol).toBe("AAPL");
  });
});

describe("localStorageAdapter — templates", () => {
  it("save + list + load + remove template round-trip", async () => {
    const a = localStorageAdapter({ storage });
    expect(a.saveTemplate).toBeDefined();
    expect(a.listTemplates).toBeDefined();
    expect(a.loadTemplate).toBeDefined();
    expect(a.removeTemplate).toBeDefined();
    const meta = await a.saveTemplate!({ name: "dark candles", state: sampleState() });
    const list = await a.listTemplates!();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(meta.id);
    const loaded = await a.loadTemplate!(meta.id);
    expect(loaded?.primaryChannelId).toBe(sampleState().primaryChannelId);
    await a.removeTemplate!(meta.id);
    await expect(a.listTemplates!()).resolves.toEqual([]);
  });
});
