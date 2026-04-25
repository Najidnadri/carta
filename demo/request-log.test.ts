import { describe, expect, it } from "vitest";
import { RequestLog } from "./request-log.js";

const baseEntry = {
  channelId: "primary",
  kind: "ohlc" as const,
  interval: 60_000,
  start: 0,
  end: 60_000,
  source: "data:request" as const,
};

describe("RequestLog", () => {
  it("assigns monotonic seq numbers and tracks total pushed", () => {
    const log = new RequestLog({ capacity: 5, clock: () => 0 });
    log.push(baseEntry);
    log.push(baseEntry);
    log.push(baseEntry);
    const snap = log.snapshot();
    expect(snap.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.totalPushed()).toBe(3);
  });

  it("drops oldest entries when capacity is exceeded", () => {
    const log = new RequestLog({ capacity: 3, clock: () => 0 });
    for (let i = 0; i < 5; i++) {
      log.push(baseEntry);
    }
    expect(log.size()).toBe(3);
    expect(log.snapshot().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(log.totalPushed()).toBe(5);
  });

  it("clear resets size + seq", () => {
    const log = new RequestLog({ capacity: 5, clock: () => 0 });
    log.push(baseEntry);
    log.push(baseEntry);
    log.clear();
    expect(log.size()).toBe(0);
    expect(log.totalPushed()).toBe(0);
    log.push(baseEntry);
    expect(log.snapshot()[0]?.seq).toBe(1);
  });

  it("preserves source tag for cache-hit-synthetic rows", () => {
    const log = new RequestLog({ capacity: 5, clock: () => 0 });
    log.push({ ...baseEntry, source: "cache-hit-synthetic" });
    expect(log.snapshot()[0]?.source).toBe("cache-hit-synthetic");
  });

  it("renders rows into the supplied tbody", () => {
    const tbody = document.createElement("tbody");
    const footer = document.createElement("div");
    const log = new RequestLog({ capacity: 5, tbody, footer, clock: () => 0 });
    log.push(baseEntry);
    log.push({ ...baseEntry, source: "cache-hit-synthetic" });
    expect(tbody.querySelectorAll("tr").length).toBe(2);
    expect(tbody.querySelector('tr[data-source="cache-hit-synthetic"]')).not.toBeNull();
    expect(footer.textContent).toContain("2 / 5");
  });

  it("re-renders idempotently — repeat render does not duplicate rows", () => {
    const tbody = document.createElement("tbody");
    const log = new RequestLog({ capacity: 5, tbody, clock: () => 0 });
    log.push(baseEntry);
    log.render();
    log.render();
    expect(tbody.querySelectorAll("tr").length).toBe(1);
  });
});
