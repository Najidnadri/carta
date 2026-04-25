import { describe, expect, it } from "vitest";
import { parseDrawing, parseSnapshot } from "./parsers.js";

const validTrendline = {
  id: "drw-1",
  kind: "trendline",
  schemaVersion: 1,
  style: { stroke: { color: 0xff0000, width: 1 } },
  locked: false,
  visible: true,
  z: 0,
  anchors: [
    { time: 100, price: 50, paneId: "main" },
    { time: 200, price: 60, paneId: "main" },
  ],
};

describe("parseDrawing", () => {
  it("returns null for unknown kind", () => {
    const r = parseDrawing({ ...validTrendline, kind: "unknown-kind-xx" });
    expect(r).toBeNull();
  });

  it("returns null for missing id", () => {
    const { id: _id, ...rest } = validTrendline;
    void _id;
    const r = parseDrawing(rest);
    expect(r).toBeNull();
  });

  it("returns null for non-finite time", () => {
    const r = parseDrawing({
      ...validTrendline,
      anchors: [{ time: NaN, price: 50, paneId: "main" }, { time: 200, price: 60, paneId: "main" }],
    });
    expect(r).toBeNull();
  });

  it("returns null for missing anchor count", () => {
    const r = parseDrawing({ ...validTrendline, anchors: [validTrendline.anchors[0]] });
    expect(r).toBeNull();
  });

  it("parses a valid trendline preserving fields", () => {
    const r = parseDrawing(validTrendline);
    expect(r?.kind).toBe("trendline");
    expect(r?.id).toBe("drw-1");
    expect(r?.anchors.length).toBe(2);
  });

  it("preserves meta verbatim through parse", () => {
    const r = parseDrawing({ ...validTrendline, meta: { customField: "x", n: 1 } });
    expect(r?.meta).toEqual({ customField: "x", n: 1 });
  });
});

describe("parseSnapshot", () => {
  it("returns empty snapshot for null/non-object input", () => {
    const r = parseSnapshot(null);
    expect(r.snapshot.drawings.length).toBe(0);
    expect(r.droppedCount).toBe(0);
    expect(r.unsupportedSchemaVersion).toBeNull();
  });

  it("flags unsupported numeric schemaVersion", () => {
    const r = parseSnapshot({ schemaVersion: 99, drawings: [] });
    expect(r.snapshot.drawings.length).toBe(0);
    expect(r.droppedCount).toBe(0);
    expect(r.unsupportedSchemaVersion).toBe(99);
  });

  it("leaves unsupportedSchemaVersion null for valid input", () => {
    const r = parseSnapshot({ schemaVersion: 1, drawings: [] });
    expect(r.unsupportedSchemaVersion).toBeNull();
  });

  it("drops unknown kinds + reports them", () => {
    const r = parseSnapshot({
      schemaVersion: 1,
      drawings: [
        validTrendline,
        { ...validTrendline, kind: "futuristic-tool", id: "drw-2" },
        { ...validTrendline, id: "drw-3" },
      ],
    });
    expect(r.snapshot.drawings.length).toBe(2);
    expect(r.droppedCount).toBe(1);
    expect(r.droppedKinds).toContain("futuristic-tool");
  });

  it("drops invalid records (e.g. anchors missing) and counts them", () => {
    const r = parseSnapshot({
      schemaVersion: 1,
      drawings: [validTrendline, { ...validTrendline, anchors: [], id: "broken" }],
    });
    expect(r.snapshot.drawings.length).toBe(1);
    expect(r.droppedCount).toBe(1);
  });

  it("round-trips a valid snapshot byte-equal modulo key order", () => {
    const snap = {
      schemaVersion: 1 as const,
      drawings: [validTrendline],
    };
    const parsed = parseSnapshot(snap);
    expect(parsed.snapshot.drawings.length).toBe(1);
    // Re-stringify both: structural equality.
    const reJson = JSON.stringify(parsed.snapshot.drawings[0]);
    const original = JSON.stringify(validTrendline);
    expect(JSON.parse(reJson)).toEqual(JSON.parse(original));
  });
});
