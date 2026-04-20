import { describe, it, expect } from "vitest";
import type { Graphics } from "pixi.js";
import {
  DASH_PATTERNS,
  INITIAL_DASH_STATE,
  emitDashedSegment,
  type DashState,
} from "./dashSegment.js";

interface Call {
  readonly type: "moveTo" | "lineTo";
  readonly x: number;
  readonly y: number;
}

interface FakeGraphics {
  readonly calls: Call[];
  moveTo(x: number, y: number): FakeGraphics;
  lineTo(x: number, y: number): FakeGraphics;
}

function makeGraphics(): FakeGraphics {
  const calls: Call[] = [];
  const self: FakeGraphics = {
    calls,
    moveTo(x, y) { calls.push({ type: "moveTo", x, y }); return self; },
    lineTo(x, y) { calls.push({ type: "lineTo", x, y }); return self; },
  };
  return self;
}

function emit(
  g: FakeGraphics,
  x0: number, y0: number, x1: number, y1: number,
  pattern: readonly [number, number],
  state: DashState,
): { state: DashState; emitted: number } {
  // FakeGraphics mirrors the narrow surface used by emitDashedSegment.
  return emitDashedSegment(g as unknown as Graphics, x0, y0, x1, y1, pattern, state);
}

describe("emitDashedSegment", () => {
  it("emits one dash pair for a 6-px horizontal segment with dashed pattern", () => {
    const g = makeGraphics();
    const r = emit(g, 0, 0, 6, 0, DASH_PATTERNS.dashed, INITIAL_DASH_STATE);
    expect(r.emitted).toBe(1);
    expect(g.calls).toEqual([
      { type: "moveTo", x: 0, y: 0 },
      { type: "lineTo", x: 6, y: 0 },
    ]);
    // Phase just consumed the full "on" portion; next state is "off" with phase reset.
    expect(r.state.inkOn).toBe(false);
    expect(r.state.phase).toBe(0);
  });

  it("carries phase across consecutive segments (9 px + 6 px dashed)", () => {
    const g = makeGraphics();
    // Segment 1: 9 px — emits one 6-on, runs 3 off, lands right at next "on".
    const r1 = emit(g, 0, 0, 9, 0, DASH_PATTERNS.dashed, INITIAL_DASH_STATE);
    expect(r1.emitted).toBe(1);
    expect(r1.state.inkOn).toBe(true);
    expect(r1.state.phase).toBe(0);
    // Segment 2: continues from a fresh "on" — emits another 6-on at its start.
    const r2 = emit(g, 9, 0, 15, 0, DASH_PATTERNS.dashed, r1.state);
    expect(r2.emitted).toBe(1);
    expect(g.calls).toEqual([
      { type: "moveTo", x: 0, y: 0 },
      { type: "lineTo", x: 6, y: 0 },
      { type: "moveTo", x: 9, y: 0 },
      { type: "lineTo", x: 15, y: 0 },
    ]);
  });

  it("splits a dash across a segment boundary, preserving phase", () => {
    // 4 px segment → 4 of the 6-on consumed; next segment starts mid-dash.
    const g = makeGraphics();
    const r1 = emit(g, 0, 0, 4, 0, DASH_PATTERNS.dashed, INITIAL_DASH_STATE);
    expect(r1.emitted).toBe(1);
    expect(r1.state.inkOn).toBe(true);
    expect(r1.state.phase).toBeCloseTo(4);
    const r2 = emit(g, 4, 0, 10, 0, DASH_PATTERNS.dashed, r1.state);
    // Remaining 2 px of on; then 3 px off; then 1 px of next on.
    expect(r2.emitted).toBe(2);
    expect(g.calls).toEqual([
      { type: "moveTo", x: 0, y: 0 }, { type: "lineTo", x: 4, y: 0 },
      { type: "moveTo", x: 4, y: 0 }, { type: "lineTo", x: 6, y: 0 },
      { type: "moveTo", x: 9, y: 0 }, { type: "lineTo", x: 10, y: 0 },
    ]);
  });

  it("measures dash length along the hypotenuse of diagonal segments", () => {
    const g = makeGraphics();
    // 3-4-5 triangle: total length 5 exactly; 5 < 6 on-length so no boundary crossed.
    const r = emit(g, 0, 0, 3, 4, DASH_PATTERNS.dashed, INITIAL_DASH_STATE);
    expect(r.emitted).toBe(1);
    expect(g.calls).toHaveLength(2);
    const [start, end] = g.calls;
    expect(start).toEqual({ type: "moveTo", x: 0, y: 0 });
    expect(end?.x).toBeCloseTo(3);
    expect(end?.y).toBeCloseTo(4);
    expect(r.state.phase).toBeCloseTo(5);
  });

  it("emits nothing for zero-length segments and does not mutate state", () => {
    const g = makeGraphics();
    const r = emit(g, 10, 10, 10, 10, DASH_PATTERNS.dashed, { phase: 2, inkOn: true });
    expect(r.emitted).toBe(0);
    expect(g.calls).toHaveLength(0);
    expect(r.state).toEqual({ phase: 2, inkOn: true });
  });

  it("emits nothing for non-finite coords", () => {
    const g = makeGraphics();
    const r = emit(g, 0, 0, Number.NaN, 5, DASH_PATTERNS.dashed, INITIAL_DASH_STATE);
    expect(r.emitted).toBe(0);
    expect(g.calls).toHaveLength(0);
  });

  it("dotted pattern: short segment of 1 px emits a single 1-px dot", () => {
    const g = makeGraphics();
    const r = emit(g, 0, 0, 1, 0, DASH_PATTERNS.dotted, INITIAL_DASH_STATE);
    expect(r.emitted).toBe(1);
    expect(g.calls).toEqual([
      { type: "moveTo", x: 0, y: 0 },
      { type: "lineTo", x: 1, y: 0 },
    ]);
    expect(r.state.inkOn).toBe(false);
  });

  it("handles a long segment containing many dash cycles", () => {
    const g = makeGraphics();
    // 45 px at 6/3 cycle (=9 px): 5 full on-dashes, final state at on-boundary.
    const r = emit(g, 0, 0, 45, 0, DASH_PATTERNS.dashed, INITIAL_DASH_STATE);
    expect(r.emitted).toBe(5);
    expect(r.state.inkOn).toBe(true);
    expect(r.state.phase).toBe(0);
  });
});
