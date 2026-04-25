---
name: carta
description: Expert guidance for integrating the Carta charting library (GPU-accelerated PixiJS v8 time-series chart) into a host app. Use whenever the user is writing or modifying code that imports from `carta` — e.g. `import { TimeSeriesChart, CandlestickSeries } from 'carta'` — or asks "how do I use Carta", "add a chart with Carta", "wire data to Carta", "embed Carta in React/Vue/Svelte/vanilla TS", "Carta isn't fetching data", "Carta on mobile". This skill teaches the data-driven event flow (chart asks for data, host responds via `data:request`), per-channel caching, async `create()`, mobile gestures, theme swap, and the framework-integration patterns that don't show up in the README. Trigger early — most Carta bugs are misuses of the request/supply event loop.
---

# Carta integration skill

Carta is a pre-1.0 GPU-accelerated time-series charting library on PixiJS v8. One primary class, `TimeSeriesChart`, plus a small set of series classes (`CandlestickSeries`, `OhlcBarSeries`, `HeikinAshiSeries`, `LineSeries`, `AreaSeries`, `HistogramSeries`, `BaselineSeries`, `MarkerOverlay`). Mobile-first, event-driven, render-on-demand.

This skill is for hosts integrating Carta — Vite/Next/Remix/SvelteKit apps that import from `carta` and need to wire data, layout, and interaction without fighting the library.

## Quick mental model — read this first

Carta inverts the data flow most chart libraries use.

- **You do not push data.** The chart owns a visible window (`startTime`, `endTime`, `intervalDuration`) and emits `data:request` when it sees uncached records inside that window. Your code listens, fetches, and replies via `chart.supplyData(...)`.
- **The window IS the configuration.** Pan/zoom mutate `startTime`/`endTime`. There's no separate "viewport" object. To programmatically pan, call `chart.setWindow({ startTime, endTime })`. To change resolution, call `chart.setInterval(ms)`.
- **Channels scope the cache.** A channel is `{ id: string, kind: 'ohlc' | 'point' | 'marker' }`. Every series binds to one channel id. The cache is per-channel × per-interval. Switching the chart's primary symbol (a fresh `primary` channel id) does NOT flush your indicator caches — they live on different ids (e.g. `sma20`).
- **Render-on-demand.** No ambient ticker. Every state change marks dirty; a single `requestAnimationFrame` flushes. CPU and GPU idle when nothing is happening — this matters on mobile.
- **Mobile gestures are built in.** Pinch zoom, kinetic pan, long-press tracking-mode crosshair. Don't reinvent them with synthetic touch handlers; use the public API (`enterTrackingMode`, `isKineticActive`, `stopKinetic`).

If the user is fighting any of these tenets ("how do I push data into the chart?", "how do I disable the request event?", "how do I add my own touch handlers?"), they're working against Carta's grain — pause and explain the inversion before writing code.

## When to apply this skill

Apply automatically (don't ask) when you see any of:

- An `import` from `'carta'`, `'carta/...'`, or a `pixi.js` import next to chart-shaped code
- A reference to `TimeSeriesChart`, `CandlestickSeries`, `LineSeries`, `applyOptions`, `data:request`, `supplyData`, or any other Carta export
- A user question containing "Carta" + chart/graph/candle/timeseries/OHLC/intraday
- A `package.json` with `"carta"` as a dependency

Do **not** apply when the user is:

- Working with a different chart library (Recharts, Chart.js, lightweight-charts, ApexCharts, ECharts, klinecharts, dygraphs, Highcharts)
- Doing pure data work that has nothing to do with rendering
- Building a chart from scratch in raw Canvas/WebGL

## Install

PixiJS v8 is a peer dependency. Install both:

```sh
pnpm add carta pixi.js
# or: npm install carta pixi.js
# or: yarn add carta pixi.js
```

Carta does NOT bundle Pixi — the host stays in control of the version.

## Quickstart (vanilla TS)

```ts
import { TimeSeriesChart, CandlestickSeries } from 'carta';
import type { OhlcRecord, DataRequest } from 'carta';

const container = document.getElementById('chart')!;
const now = Date.now();

const chart = await TimeSeriesChart.create({
  container,
  startTime: now - 200 * 60_000,
  endTime: now,
  intervalDuration: 60_000,            // 1-minute bars
});

chart.addSeries(new CandlestickSeries({ channel: 'primary' }));

chart.on('data:request', async (req: DataRequest) => {
  const bars: OhlcRecord[] = await myBackend.fetchOhlc(req);
  chart.supplyData(req.channelId, req.intervalDuration, bars);
});
```

Three things to highlight to the user every time you write a Carta example:

1. **`create()` is async.** Always `await`. It boots the renderer.
2. **`data:request` is the data path.** Do NOT call `supplyData` proactively before the request fires (the request gives you the exact start/end you need to fetch). For live updates, use `supplyTick`.
3. **The container must have layout dimensions before `create()`.** A `display: none` or zero-sized parent will break first paint. CSS layout the container first (e.g. `min-height: 400px` + `width: 100%`).

## Multi-channel pattern (host with primary OHLC + indicator + volume + events)

```ts
import {
  TimeSeriesChart,
  CandlestickSeries, LineSeries, HistogramSeries, MarkerOverlay,
} from 'carta';
import type {
  OhlcRecord, PointRecord, MarkerRecord, DataRequest,
} from 'carta';

const chart = await TimeSeriesChart.create({
  container, startTime, endTime, intervalDuration: 60_000,
});

chart.addSeries(new CandlestickSeries({ channel: 'primary' }));
chart.addSeries(new LineSeries({ channel: 'sma20', color: 0x58a6ff, lineWidth: 1.5 }));
chart.addSeries(new HistogramSeries({ channel: 'volume', participatesInAutoScale: false }));
chart.addSeries(new MarkerOverlay({
  channel: 'events',
  priceReference: { channel: 'primary', field: 'high' },
}));

chart.on('data:request', async (req: DataRequest) => {
  switch (req.channelId) {
    case 'primary':  chart.supplyData('primary',  req.intervalDuration, await myBackend.fetchOhlc(req));   break;
    case 'sma20':    chart.supplyData('sma20',    req.intervalDuration, await myBackend.fetchSma(req, 20));break;
    case 'volume':   chart.supplyData('volume',   req.intervalDuration, await myBackend.fetchVolume(req)); break;
    case 'events':   chart.supplyData('events',   req.intervalDuration, await myBackend.fetchEvents(req)); break;
  }
});
```

Note `participatesInAutoScale: false` on the volume histogram — without it, the auto-scale domain stretches to include volume base 0, crushing the candles. Always set this for any overlay that sits on a different magnitude than the primary price.

`MarkerOverlay`'s `priceReference` lets a marker channel piggy-back on a different channel's bar data for its Y anchor — pass `{ channel: 'primary', field: 'high' | 'low' | 'close' }` to anchor on the OHLC channel's bars without a second fetch.

## Public API at a glance

For the full reference, see [reference.md](reference.md) (loaded on demand).

**Construction & lifecycle**
- `static TimeSeriesChart.create(opts: TimeSeriesChartConstructionOptions): Promise<TimeSeriesChart>` — async, `await` mandatory
- `chart.destroy()` — call in framework cleanup (React `useEffect` return, Vue `onUnmounted`, Svelte `onDestroy`)

**Window & interval**
- `chart.setWindow({ startTime, endTime })` — pan/zoom both edges
- `chart.getWindow()` — `ChartWindow` snapshot
- `chart.setInterval(ms)` — change resolution; **invalidates the previous interval's cache bucket** per channel
- `chart.getInterval()` — current `Interval`
- `chart.resize(w, h)` — manual resize; auto-resize is on by default

**Data & cache**
- `chart.defineChannel({ id, kind })` — pre-register; `addSeries` auto-defines, so this is rare
- `chart.supplyData(channelId, interval, records)` — respond to `data:request`
- `chart.supplyTick(channelId, record, interval?)` — live update; replaces a same-time bar
- `chart.clearCache({ channelId?, intervalDuration? })` — surgical or whole-cache flush
- `chart.cacheStats()` — inspect what's loaded
- `chart.recordsInRange(channelId, interval, start, end)` — read cached data
- `chart.missingRanges(channelId, query?)` — what's still uncached
- `chart.hasPendingDataRequest()` — true if a request is in flight

**Series**
- `chart.addSeries(series)` — returns the series for chaining
- `chart.removeSeries(series)` — returns `true` if found

**Interaction**
- `chart.enterTrackingMode({ time?, price? })` — programmatic crosshair pin
- `chart.exitTrackingMode()` / `chart.isTrackingMode()`
- `chart.isKineticActive()` / `chart.stopKinetic()`

**Theme & price scale**
- `chart.applyOptions({ theme?: Partial<Theme>, priceFormatter? })` — runtime patch
- `chart.priceScale()` — facade: `setDomain`, `getDomain`, `setAutoScale`, `isAutoScale`
- `chart.addPriceRangeProvider(provider)` / `removePriceRangeProvider(provider)` — inject extra ranges into auto-scale (e.g. for drawing tools)

**Events**
- `chart.on(event, handler)` / `off` / `once` / `removeAllListeners`
- 6 events: `window:change`, `interval:change`, `data:request`, `crosshair:move`, `tracking:change`, `resize`

## Series picker

| Need | Series | Channel kind | Key option |
|---|---|---|---|
| Standard candles | `CandlestickSeries` | `ohlc` | `upColor` / `downColor` |
| OHLC bar (open/close ticks) | `OhlcBarSeries` | `ohlc` | `thinBars` for dense windows |
| Heikin-Ashi smoothing | `HeikinAshiSeries` | `ohlc` | same as candles |
| Polyline | `LineSeries` | `point` | `lineStyle: 'solid' \| 'dashed' \| 'dotted'`, `lineType: 'simple' \| 'stepped'` |
| Filled-line | `AreaSeries` | `point` | `topColor` / `bottomColor` / `topAlpha` / `baseline` |
| Bars from a base value | `HistogramSeries` | `point` | `base`, `participatesInAutoScale` |
| Two-tone area (above/below baseline) | `BaselineSeries` | `point` | `baseline: number \| 'first' \| 'average'` |
| Sparse glyphs anchored to a price | `MarkerOverlay` | `marker` | `priceReference: { channel, field? }` |

Every series accepts `applyOptions(patch)` for runtime tweaks. Per-series colour options always beat theme values.

## Framework integration patterns

### React / Next.js

```tsx
import { useEffect, useRef } from 'react';
import { TimeSeriesChart, CandlestickSeries } from 'carta';
import type { TimeSeriesChart as Chart } from 'carta';

export function CartaChart({ symbol, fetchOhlc }: { symbol: string; fetchOhlc: (req: any) => Promise<any[]> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    (async () => {
      const now = Date.now();
      const chart = await TimeSeriesChart.create({
        container: containerRef.current!,
        startTime: now - 200 * 60_000,
        endTime: now,
        intervalDuration: 60_000,
      });
      if (cancelled) { chart.destroy(); return; }

      chartRef.current = chart;
      chart.addSeries(new CandlestickSeries({ channel: 'primary' }));
      chart.on('data:request', async req => {
        const bars = await fetchOhlc(req);
        chart.supplyData(req.channelId, req.intervalDuration, bars);
      });
    })();

    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);  // re-run only on mount; symbol changes handled below

  // Symbol switch — clear cache and let the chart re-request
  useEffect(() => {
    chartRef.current?.clearCache({ channelId: 'primary' });
  }, [symbol]);

  return <div ref={containerRef} style={{ width: '100%', height: 480 }} />;
}
```

**React rules of thumb:**
- Hold the chart instance in a `useRef`, not in state. State updates trigger React re-renders that reset the ref. The chart should outlive React renders.
- Run `create()` once, in a single `useEffect` with an empty dep array. Use the `cancelled` flag to handle StrictMode double-mount + unmount-during-create races.
- For symbol/timeframe changes, mutate the existing chart (`clearCache`, `setInterval`, `setWindow`) — never recreate it.
- Always call `destroy()` in the cleanup return. Forgetting this leaks GPU contexts.

### Vue 3 / Nuxt

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { TimeSeriesChart, CandlestickSeries } from 'carta';

const containerEl = ref<HTMLDivElement | null>(null);
let chart: Awaited<ReturnType<typeof TimeSeriesChart.create>> | null = null;

onMounted(async () => {
  if (!containerEl.value) return;
  const now = Date.now();
  chart = await TimeSeriesChart.create({
    container: containerEl.value,
    startTime: now - 200 * 60_000,
    endTime: now,
    intervalDuration: 60_000,
  });
  chart.addSeries(new CandlestickSeries({ channel: 'primary' }));
  chart.on('data:request', async req => {
    chart!.supplyData(req.channelId, req.intervalDuration, await fetchOhlc(req));
  });
});

onBeforeUnmount(() => { chart?.destroy(); chart = null; });
</script>

<template>
  <div ref="containerEl" class="carta-chart" />
</template>

<style scoped>
.carta-chart { width: 100%; height: 480px; }
</style>
```

### Svelte 5

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { TimeSeriesChart, CandlestickSeries } from 'carta';

  let container: HTMLDivElement;
  let chart: Awaited<ReturnType<typeof TimeSeriesChart.create>> | null = null;

  onMount(() => {
    let cancelled = false;
    (async () => {
      const now = Date.now();
      const c = await TimeSeriesChart.create({
        container,
        startTime: now - 200 * 60_000,
        endTime: now,
        intervalDuration: 60_000,
      });
      if (cancelled) { c.destroy(); return; }
      chart = c;
      chart.addSeries(new CandlestickSeries({ channel: 'primary' }));
      chart.on('data:request', async req => {
        chart!.supplyData(req.channelId, req.intervalDuration, await fetchOhlc(req));
      });
    })();
    return () => { cancelled = true; chart?.destroy(); chart = null; };
  });
</script>

<div bind:this={container} class="chart" />
<style>.chart { width: 100%; height: 480px; }</style>
```

### SSR (Next.js / Nuxt / SvelteKit)

Carta touches `document` and the GPU — it's strictly **client-only**. Patterns:

- **Next.js:** mark the component `'use client'`. Or wrap with `dynamic(() => import('./Chart'), { ssr: false })`.
- **Nuxt:** wrap in `<ClientOnly>...</ClientOnly>`.
- **SvelteKit:** import inside `onMount` (which only runs in the browser) or branch on `import { browser } from '$app/environment'`.

Don't import `carta` at module top level on a page that gets server-rendered — it'll throw on `document is not defined`.

## Live-data patterns

### Polling (REST)

```ts
chart.on('data:request', async req => {
  chart.supplyData(req.channelId, req.intervalDuration, await rest.fetch(req));
});
// Periodic refresh of the rightmost bar:
setInterval(async () => {
  const tick = await rest.fetchLatest('primary');
  chart.supplyTick('primary', tick);
}, 1000);
```

### WebSocket (preferred for live)

```ts
const ws = new WebSocket('wss://api/...');
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'tick') chart.supplyTick(msg.channelId, msg.record);
});

// Initial backfill still goes through data:request:
chart.on('data:request', async req => {
  chart.supplyData(req.channelId, req.intervalDuration, await rest.backfill(req));
});
```

### Symbol switch without flushing indicator caches

```ts
chart.clearCache({ channelId: 'primary' });   // only the primary OHLC
// sma20 / volume / events caches survive — chart re-requests primary, re-renders
```

This is the channel-scoping payoff. If you `clearCache()` with no args you nuke everything; almost always you want the channel-scoped form.

## Anti-patterns to flag

If the user writes any of these, stop and correct:

- ❌ **Calling `supplyData` proactively without listening for `data:request`.** The chart's window-tracking will fire its own request anyway; the proactive call may double-fetch or supply records outside the visible window. Wire the event first.
- ❌ **Awaiting `chart.create()` inside a render function.** React/Vue will recreate the chart on every render. Use a ref + a one-shot `useEffect`/`onMounted`.
- ❌ **Mutating records after passing them to `supplyData`.** Carta sorts and de-dupes by `time` but doesn't deep-copy. Treat the array as transferred ownership; if you need to update, send a new array (or use `supplyTick` for single records).
- ❌ **Setting `intervalDuration` to a non-aligned value** (e.g. 90_000 ms = 1.5 min). It works, but bar `time` values must be exact multiples of `intervalDuration`. Stick to the natural set: 1m, 5m, 15m, 1h, 4h, 1D, etc.
- ❌ **Storing the chart instance in React state.** Use `useRef`. State triggers re-renders.
- ❌ **Recreating the chart on prop changes.** `setWindow`, `setInterval`, `clearCache`, `applyOptions` are all live mutations. Recreating is expensive and loses caches.
- ❌ **Forgetting `chart.destroy()` in cleanup.** Leaks the WebGL context. Browsers cap WebGL contexts at ~16 — exhaust them and pages stop rendering.
- ❌ **Trying to wire your own pinch/long-press handlers.** They're built in. You'd be re-implementing what `ViewportController` and `CrosshairController` already do, and you'll fight the gesture recognizers.
- ❌ **Using a fixed-pixel container without `min-height`.** `0`-height container = no first paint = looks like the chart is broken.
- ❌ **Using `console.log` for diagnostics from your handlers.** Carta accepts a `Logger` in its options (`{ debug, info, warn, error }`); plumb yours through and your runtime stays clean.

## Theming

```ts
import { TimeSeriesChart, LightTheme, DarkTheme } from 'carta';

// At construction:
const chart = await TimeSeriesChart.create({
  /* ... */
  theme: { ...LightTheme, gridAlpha: 0.4 },
});

// At runtime:
chart.applyOptions({ theme: DarkTheme });               // full swap
chart.applyOptions({ theme: { background: 0x0a0e14 }}); // partial patch
```

`Theme` is a flat interface (no nested sections — easy `Partial<Theme>` merging). Per-series colour options (e.g. `CandlestickSeries.upColor`) always win over a theme value.

For the full `Theme` field list, see [reference.md](reference.md).

## Branded types — what to tell the user

Carta uses TypeScript branded types for unit-bearing numbers: `Time` (ms epoch), `Interval` (ms per bar), `Pixel`, `Price`. They prevent unit confusion at compile time, with zero runtime cost.

**On input** — every public method accepts `Time | number`, `Interval | number`, etc. Pass plain numbers; no cast required.

**On output** (e.g. `getWindow()`, `crosshair:move` payload) the brand is preserved. Arithmetic and assignment back to `number` works without an explicit cast:

```ts
chart.on('window:change', win => {
  const minutes = (win.endTime - win.startTime) / 60_000;  // OK, returns number
});
```

If a user hits a TS error like "Type 'number' is not assignable to type 'Time'", they're constructing a record literal. Use the helpers:

```ts
import { asTime, asPrice } from 'carta';

const tick: OhlcRecord = {
  time: asTime(Date.now()),
  open: asPrice(100),
  high: asPrice(101),
  low:  asPrice(99),
  close: asPrice(100.5),
};
```

## Mobile checklist

When the user is shipping to phones:

- ✅ Pinch zoom, kinetic pan, long-press tracking — built in. Don't override.
- ✅ The container needs `min-height` in CSS (`50svh` or `400px`). A `0`-height container is the #1 mobile-first-paint failure.
- ✅ DPR is auto-snapped to `{1, 1.5, 2}` to avoid PixiJS v8 fractional-resolution artifacts.
- ✅ For tap targets in the surrounding UI (interval buttons, theme toggle), 44 px minimum.
- ⚠ Long-press hold-time defaults to ~500 ms. Don't add a competing tap-and-hold listener on a parent — it eats Carta's gesture.
- ⚠ Don't put the chart inside a `<div>` with `touch-action: pan-y` — Carta needs full pointer-event control.

## Common questions

**"How do I change the symbol?"**
`chart.clearCache({ channelId: 'primary' })` then the chart auto-requests fresh data on its next render. Or supply the new bars proactively after clearing.

**"How do I jump to a specific date?"**
`chart.setWindow({ startTime, endTime })` — both as plain numbers (ms epoch).

**"How do I show a 'no data' overlay?"**
Listen for `data:request` and cross-check against your backend; render your own DOM element absolutely-positioned over the chart container. Carta is canvas-only — DOM overlays are the host's job.

**"Can I add a custom indicator?"**
Carta doesn't have an indicator engine in v0. Compute the indicator host-side (e.g. SMA, RSI), feed it through a `LineSeries` on its own channel id. The plugin architecture for custom series is on the roadmap (phase 16).

**"How do I export the chart as PNG?"**
Not in v0. Roadmap phase 15. For now, if you really need it, grab the canvas via the container DOM tree and call `canvas.toBlob('image/png')` yourself.

**"Why is my chart blank?"**
Top three causes: (1) container has zero height — set `min-height` in CSS; (2) you forgot to `await` `create()` — chart is a Promise; (3) you're not handling `data:request` — listen + supply. If none apply, check the browser console for `WebGL context lost` (too many charts) or `pixi.js` errors.

**"How do I get the data the user is currently looking at?"**
`chart.recordsInRange(channelId, intervalDuration, startTime, endTime)` — reads from cache. Or `chart.barsInWindow()` for just the timestamps.

## Reference & deeper material

For deeper material, defer to:

- [reference.md](reference.md) — full API reference with every option, every event payload, every series option type.
- [examples.md](examples.md) — longer example apps: drawing-tool integration, custom price-range provider, multi-chart dashboard, websocket reconnection pattern.
- The package's own [README.md](https://github.com/Najidnadri/carta/blob/main/README.md) — install, quickstart, status section.
- The repo's [plans/master-plan.md](https://github.com/Najidnadri/carta/blob/main/plans/master-plan.md) for the roadmap.

If the user asks for something not covered (drawing tools, multi-pane layouts, plugin custom series, save/load, accessibility), tell them: **"That's on the Carta roadmap (phase 13–17) but not shipped in v0.0. For now, do X workaround."** Don't pretend an API exists.

## Status of this skill

Targets Carta `v0.0` (pre-1.0). API may change minorly before v1; pin exact versions in production. Update this skill when:

- A new public method lands on `TimeSeriesChart`
- A new event is added to `CartaEventMap`
- A new series class ships
- A method is renamed (capture in the anti-patterns list above)

The Carta repo's `plans/master-plan.md` is the canonical roadmap.
