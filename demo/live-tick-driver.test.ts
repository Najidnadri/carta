import { describe, expect, it } from "vitest";
import { LiveTickDriver } from "./live-tick-driver.js";
import { MockSource } from "./mock-source.js";
import {
  asInterval,
  asTime,
  type DataRecord,
  type Interval,
  type OhlcRecord,
  type Time,
  type TimeSeriesChart,
} from "../src/index.js";

const MIN = 60_000;

interface FakeChart {
  records: OhlcRecord[];
  interval: number;
  ticks: { channel: string; record: DataRecord }[];
}

function makeFakeChart(initial: OhlcRecord[] = [], interval: number = MIN): FakeChart & { chart: TimeSeriesChart } {
  const state: FakeChart = {
    records: [...initial],
    interval,
    ticks: [],
  };
  const chart = {
    getInterval: (): Interval => asInterval(state.interval),
    recordsInRange: (
      _channelId: string,
      _iv: Interval | number,
      start: Time | number,
      end: Time | number,
    ): readonly DataRecord[] => {
      const s = Number(start);
      const e = Number(end);
      return state.records.filter((r) => {
        const t = Number(r.time);
        return t >= s && t <= e;
      });
    },
    supplyTick: (channelId: string, record: DataRecord, _iv?: Interval | number): void => {
      state.ticks.push({ channel: channelId, record });
      if ("open" in record) {
        const idx = state.records.findIndex((r) => Number(r.time) === Number(record.time));
        if (idx >= 0) {
          state.records[idx] = record;
        } else {
          state.records.push(record);
        }
      }
    },
  } as unknown as TimeSeriesChart;
  return { ...state, chart };
}

describe("LiveTickDriver", () => {
  it("does not fire before start()", () => {
    const fc = makeFakeChart();
    const now = 0;
    const driver = new LiveTickDriver({
      chart: fc.chart,
      source: new MockSource(),
      ohlcChannel: "ohlc",
      volumeChannel: "vol",
      intervalMs: 1000,
      clock: () => now,
      setTimer: () => 0 as unknown as number,
      clearTimer: () => undefined,
    });
    expect(driver.isRunning()).toBe(false);
    expect(driver.tickCounter()).toBe(0);
  });

  it("fires once per cadence and increments tickCounter", () => {
    const fc = makeFakeChart([
      {
        time: asTime(MIN),
        open: 100 as unknown as OhlcRecord["open"],
        high: 102 as unknown as OhlcRecord["high"],
        low: 99 as unknown as OhlcRecord["low"],
        close: 101 as unknown as OhlcRecord["close"],
        volume: 500,
      },
    ]);
    let now = 0;
    const pending: { cb: (() => void) | null } = { cb: null };
    const driver = new LiveTickDriver({
      chart: fc.chart,
      source: new MockSource(),
      ohlcChannel: "ohlc",
      volumeChannel: "vol",
      intervalMs: 1000,
      clock: () => now,
      setTimer: (cb: () => void): number => {
        pending.cb = cb;
        return 1 as unknown as number;
      },
      clearTimer: () => undefined,
    });
    driver.start();
    expect(driver.isRunning()).toBe(true);
    // Advance clock + invoke the scheduled callback once.
    now = 1000;
    pending.cb?.();
    expect(driver.tickCounter()).toBe(1);
    expect(fc.ticks.length).toBe(2); // one ohlc + one volume
    expect(fc.ticks[0]?.channel).toBe("ohlc");
    expect(fc.ticks[1]?.channel).toBe("vol");
  });

  it("stop() cancels the timer and prevents future fires", () => {
    const fc = makeFakeChart();
    let cleared = false;
    const driver = new LiveTickDriver({
      chart: fc.chart,
      source: new MockSource(),
      ohlcChannel: "ohlc",
      volumeChannel: "vol",
      intervalMs: 1000,
      clock: () => 0,
      setTimer: () => 7 as unknown as number,
      clearTimer: (id) => {
        if (id === 7) {
          cleared = true;
        }
      },
    });
    driver.start();
    driver.stop();
    expect(driver.isRunning()).toBe(false);
    expect(cleared).toBe(true);
  });

  it("schedules drift-free against the absolute schedule", () => {
    const fc = makeFakeChart();
    let now = 0;
    const delays: number[] = [];
    const pending: { cb: (() => void) | null } = { cb: null };
    const driver = new LiveTickDriver({
      chart: fc.chart,
      source: new MockSource(),
      ohlcChannel: "ohlc",
      volumeChannel: "vol",
      intervalMs: 1000,
      clock: () => now,
      setTimer: (cb, delay) => {
        delays.push(delay);
        pending.cb = cb;
        return 1 as unknown as number;
      },
      clearTimer: () => undefined,
    });
    driver.start();
    // simulate a delayed wake (browser was throttled — fired 5s late)
    now = 5_000;
    pending.cb?.();
    // next scheduled wake should target absoluteSchedule = 1000 + 1000 = 2000 → drift = max(0, 2000 - 5000) = 0
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(0);
  });
});
