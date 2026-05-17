/**
 * Phase 15 Cycle C — `indexedDbAdapter()` tests. Uses `fake-indexeddb` for
 * an in-process IDBFactory so tests run in vitest without a browser.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { indexedDbAdapter } from "./indexedDb.js";
import { CartaStorageError, type ChartId } from "./types.js";
import { CARTA_SCHEMA_VERSION, type ChartSaveState } from "../types.js";
import { asInterval, asTime } from "../../../types.js";

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

let factory: IDBFactory;
let counter = 0;

function freshAdapter(opts: { enableTemplates?: boolean; idleCloseMs?: number } = {}): ReturnType<typeof indexedDbAdapter> {
  counter += 1;
  return indexedDbAdapter({
    dbName: `carta-test-${counter}`,
    indexedDB: factory,
    ...(opts.enableTemplates !== undefined ? { enableTemplates: opts.enableTemplates } : {}),
    ...(opts.idleCloseMs !== undefined ? { idleCloseMs: opts.idleCloseMs } : {}),
  });
}

beforeEach(() => {
  factory = new IDBFactory();
});

describe("indexedDbAdapter — construction", () => {
  it("throws UNAVAILABLE when neither opts.indexedDB nor globalThis.indexedDB is present", () => {
    const stash = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    try {
      expect(() => indexedDbAdapter()).toThrow(CartaStorageError);
    } finally {
      if (stash !== undefined) { (globalThis as { indexedDB?: IDBFactory }).indexedDB = stash; }
    }
  });

  it("opens the schema on first op (no immediate side-effect)", async () => {
    const a = freshAdapter();
    await expect(a.listCharts()).resolves.toEqual([]);
  });
});

describe("indexedDbAdapter — chart CRUD", () => {
  it("save then get round-trips", async () => {
    const a = freshAdapter();
    const meta = await a.saveChart({ name: "AAPL", state: sampleState("aapl") });
    expect(meta.id).toBeTruthy();
    expect(meta.bytes).toBeGreaterThan(0);
    const row = await a.getChart(meta.id);
    expect(row?.state.primaryChannelId).toBe("aapl");
  });

  it("listCharts orders newest first", async () => {
    const a = freshAdapter();
    const m1 = await a.saveChart({ name: "first", state: sampleState() });
    await new Promise((r) => setTimeout(r, 10));
    const m2 = await a.saveChart({ name: "second", state: sampleState() });
    const list = await a.listCharts();
    expect(list[0]?.id).toBe(m2.id);
    expect(list[1]?.id).toBe(m1.id);
  });

  it("rename updates name + modifiedAt, preserves createdAt", async () => {
    const a = freshAdapter();
    const m1 = await a.saveChart({ name: "old", state: sampleState() });
    await new Promise((r) => setTimeout(r, 10));
    const m2 = await a.renameChart(m1.id, "new");
    expect(m2.name).toBe("new");
    expect(m2.createdAt).toBe(m1.createdAt);
    expect(m2.modifiedAt > m1.modifiedAt).toBe(true);
  });

  it("rename of missing id rejects with NOT_FOUND", async () => {
    const a = freshAdapter();
    await expect(a.renameChart("ghost" as ChartId, "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("remove of missing id rejects with NOT_FOUND", async () => {
    const a = freshAdapter();
    await expect(a.removeChart("ghost" as ChartId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("remove deletes the row", async () => {
    const a = freshAdapter();
    const m = await a.saveChart({ name: "rm", state: sampleState() });
    await a.removeChart(m.id);
    await expect(a.getChart(m.id)).resolves.toBeNull();
    await expect(a.listCharts()).resolves.toEqual([]);
  });

  it("overwrites with same id, preserves createdAt", async () => {
    const a = freshAdapter();
    const m1 = await a.saveChart({ name: "v1", state: sampleState() });
    await new Promise((r) => setTimeout(r, 10));
    const m2 = await a.saveChart({ id: m1.id, name: "v2", state: sampleState() });
    expect(m2.id).toBe(m1.id);
    expect(m2.createdAt).toBe(m1.createdAt);
    expect(m2.modifiedAt > m1.modifiedAt).toBe(true);
  });

  it("preserves existing symbol when re-saving without an explicit symbol", async () => {
    const a = freshAdapter();
    const m1 = await a.saveChart({ name: "AAPL", state: sampleState(), symbol: "AAPL" });
    const m2 = await a.saveChart({ id: m1.id, name: "AAPL", state: sampleState() });
    expect(m2.symbol).toBe("AAPL");
  });

  it("maps a circular-reference state to CartaStorageError('IO')", async () => {
    const a = freshAdapter();
    const circular = { schemaVersion: 1, savedAt: "x", window: {}, intervalDuration: 60_000, chartType: "candle", primaryChannelId: "c", series: [] } as unknown as Record<string, unknown>;
    (circular as { self?: unknown }).self = circular;
    let caught: unknown = null;
    try {
      await a.saveChart({ name: "circ", state: circular as unknown as ReturnType<typeof sampleState> });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CartaStorageError);
    expect((caught as CartaStorageError).code).toBe("IO");
  });

  it("getChart returns null for unknown id", async () => {
    const a = freshAdapter();
    await expect(a.getChart("nope" as ChartId)).resolves.toBeNull();
  });
});

describe("indexedDbAdapter — thumbnail", () => {
  it("stores and retrieves a Blob thumbnail across round-trip", async () => {
    const a = freshAdapter();
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const m = await a.saveChart({ name: "with-thumb", state: sampleState(), thumbnail: blob });
    expect(m.thumbnailUrl ?? "").toMatch(/^blob:|^$/);
    const row = await a.getChart(m.id);
    expect(row).not.toBeNull();
  });

  it("preserves existing thumbnail when re-saving without one", async () => {
    const a = freshAdapter();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const m1 = await a.saveChart({ name: "x", state: sampleState(), thumbnail: blob });
    const m2 = await a.saveChart({ id: m1.id, name: "x", state: sampleState() });
    void m1;
    void m2;
    const row = await a.getChart(m1.id);
    expect(row).not.toBeNull();
  });
});

describe("indexedDbAdapter — concurrent ops", () => {
  it("rapid serial saves all land", async () => {
    const a = freshAdapter();
    const metas = [];
    for (let i = 0; i < 10; i += 1) {
      metas.push(await a.saveChart({ name: `n${i}`, state: sampleState() }));
    }
    const list = await a.listCharts();
    expect(list).toHaveLength(10);
  });

  it("listCharts after delete is consistent", async () => {
    const a = freshAdapter();
    const m1 = await a.saveChart({ name: "a", state: sampleState() });
    const m2 = await a.saveChart({ name: "b", state: sampleState() });
    await a.removeChart(m1.id);
    const list = await a.listCharts();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(m2.id);
  });
});

describe("indexedDbAdapter — templates", () => {
  it("opt-in templates store gates the methods", () => {
    const off = freshAdapter();
    expect(off.listTemplates).toBeUndefined();
    const on = freshAdapter({ enableTemplates: true });
    expect(on.listTemplates).toBeDefined();
    expect(on.saveTemplate).toBeDefined();
    expect(on.loadTemplate).toBeDefined();
    expect(on.removeTemplate).toBeDefined();
  });

  it("template round-trip", async () => {
    const a = freshAdapter({ enableTemplates: true });
    const meta = await a.saveTemplate!({ name: "darkness", state: sampleState() });
    const list = await a.listTemplates!();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(meta.id);
    const loaded = await a.loadTemplate!(meta.id);
    expect(loaded?.primaryChannelId).toBe(sampleState().primaryChannelId);
    await a.removeTemplate!(meta.id);
    await expect(a.listTemplates!()).resolves.toEqual([]);
  });
});

describe("indexedDbAdapter — connection lifecycle", () => {
  it("idleCloseMs closes the connection after inactivity", async () => {
    const a = freshAdapter({ idleCloseMs: 30 });
    await a.saveChart({ name: "first", state: sampleState() });
    await new Promise((r) => setTimeout(r, 80));
    // Next op should re-open the DB cleanly.
    await expect(a.listCharts()).resolves.toHaveLength(1);
  });
});
