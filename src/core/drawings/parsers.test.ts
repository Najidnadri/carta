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

  it("Cycle B1 — round-trips ray / extendedLine / horizontalRay / parallelChannel", () => {
    const ray = {
      id: "ray-1",
      kind: "ray",
      schemaVersion: 1,
      style: { stroke: { color: 0x00ff00 } },
      locked: false,
      visible: true,
      z: 1,
      anchors: [
        { time: 100, price: 50, paneId: "main" },
        { time: 200, price: 60, paneId: "main" },
      ],
    };
    const extLine = { ...ray, id: "ext-1", kind: "extendedLine" };
    const hRay = {
      id: "hr-1",
      kind: "horizontalRay",
      schemaVersion: 1,
      style: {},
      locked: false,
      visible: true,
      z: 2,
      direction: "left",
      anchors: [{ time: 150, price: 55, paneId: "main" }],
    };
    const pc = {
      id: "pc-1",
      kind: "parallelChannel",
      schemaVersion: 1,
      style: { stroke: { color: 0xff0000 }, fill: { color: 0xff0000, alpha: 0.1 } },
      locked: false,
      visible: true,
      z: 3,
      anchors: [
        { time: 100, price: 50, paneId: "main" },
        { time: 200, price: 60, paneId: "main" },
        { time: 100, price: 45, paneId: "main" },
      ],
    };
    const snap = { schemaVersion: 1 as const, drawings: [ray, extLine, hRay, pc] };
    const parsed = parseSnapshot(snap);
    expect(parsed.snapshot.drawings.length).toBe(4);
    expect(parsed.droppedCount).toBe(0);
    expect(parsed.snapshot.drawings.map((d) => d.kind)).toEqual([
      "ray",
      "extendedLine",
      "horizontalRay",
      "parallelChannel",
    ]);
    // horizontalRay direction defaults to 'right' when missing.
    const fallback = parseSnapshot({
      schemaVersion: 1,
      drawings: [{ ...hRay, direction: undefined }],
    });
    const got = fallback.snapshot.drawings[0];
    expect(got?.kind).toBe("horizontalRay");
    if (got?.kind === "horizontalRay") {
      expect(got.direction).toBe("right");
    }
  });

  it("Cycle C.1 — round-trips pitchfork / gannFan / ellipse", () => {
    const pitchfork = {
      id: "pf-1",
      kind: "pitchfork",
      schemaVersion: 1,
      style: { stroke: { color: 0xff8800 } },
      locked: false,
      visible: true,
      z: 1,
      variant: "schiff",
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 30_000, price: 120, paneId: "main" },
        { time: 30_000, price: 80, paneId: "main" },
      ],
    };
    const gannFan = {
      id: "g-1",
      kind: "gannFan",
      schemaVersion: 1,
      style: {},
      locked: false,
      visible: true,
      z: 2,
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 60_000, price: 110, paneId: "main" },
      ],
    };
    const ellipse = {
      id: "e-1",
      kind: "ellipse",
      schemaVersion: 1,
      style: { stroke: { color: 0x4488ff } },
      locked: false,
      visible: true,
      z: 3,
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 60_000, price: 50, paneId: "main" },
      ],
    };
    const snap = { schemaVersion: 1 as const, drawings: [pitchfork, gannFan, ellipse] };
    const parsed = parseSnapshot(snap);
    expect(parsed.snapshot.drawings.length).toBe(3);
    expect(parsed.droppedCount).toBe(0);
    expect(parsed.snapshot.drawings.map((d) => d.kind)).toEqual([
      "pitchfork",
      "gannFan",
      "ellipse",
    ]);
    const pf = parsed.snapshot.drawings[0];
    if (pf?.kind === "pitchfork") {
      expect(pf.variant).toBe("schiff");
    }
  });

  it("Cycle C.1 — pitchfork unknown variant defaults to 'andrews'", () => {
    const pitchfork = {
      id: "pf-bad",
      kind: "pitchfork",
      schemaVersion: 1,
      style: {},
      locked: false,
      visible: true,
      z: 0,
      variant: "doesNotExist",
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 30_000, price: 120, paneId: "main" },
        { time: 30_000, price: 80, paneId: "main" },
      ],
    };
    const r = parseDrawing(pitchfork);
    expect(r?.kind).toBe("pitchfork");
    if (r?.kind === "pitchfork") {
      expect(r.variant).toBe("andrews");
    }
  });

  it("Cycle C.1 — pitchfork drops on NaN price", () => {
    const r = parseDrawing({
      id: "pf-nan",
      kind: "pitchfork",
      schemaVersion: 1,
      style: {},
      locked: false,
      visible: true,
      z: 0,
      variant: "andrews",
      anchors: [
        { time: 0, price: NaN, paneId: "main" },
        { time: 30_000, price: 120, paneId: "main" },
        { time: 30_000, price: 80, paneId: "main" },
      ],
    });
    expect(r).toBeNull();
  });

  it("Cycle C.1 — gannFan / ellipse drop on missing anchor count", () => {
    const gShort = parseDrawing({
      id: "g-bad",
      kind: "gannFan",
      schemaVersion: 1,
      style: {},
      locked: false,
      visible: true,
      z: 0,
      anchors: [{ time: 0, price: 100, paneId: "main" }],
    });
    expect(gShort).toBeNull();
    const eShort = parseDrawing({
      id: "e-bad",
      kind: "ellipse",
      schemaVersion: 1,
      style: {},
      locked: false,
      visible: true,
      z: 0,
      anchors: [{ time: 0, price: 100, paneId: "main" }],
    });
    expect(eShort).toBeNull();
  });
});
