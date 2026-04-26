---
name: carta
description: Expert guidance for integrating the Carta charting library (GPU-accelerated PixiJS v8 time-series chart) into a host app. Use whenever the user is writing or modifying code that imports from `carta` — e.g. `import { TimeSeriesChart, CandlestickSeries } from 'carta'` — or asks "how do I use Carta", "add a chart with Carta", "wire data to Carta", "embed Carta in React/Vue/Svelte/vanilla TS", "Carta isn't fetching data", "Carta on mobile", "add a drawing tool", "stack panes / volume in its own pane", "RSI bounded scale". This skill teaches the data-driven event flow (chart asks for data, host responds via `data:request`), per-channel caching, async `create()`, mobile gestures, theme swap, multi-pane layouts, the 26 drawing tools, and the framework-integration patterns that don't show up in the README. Trigger early — most Carta bugs are misuses of the request/supply event loop or the pane / drawing API.
---

# Carta integration skill

Carta is a pre-1.0 GPU-accelerated time-series charting library on PixiJS v8. One primary class, `TimeSeriesChart`, plus a small set of series classes (`CandlestickSeries`, `OhlcBarSeries`, `HeikinAshiSeries`, `LineSeries`, `AreaSeries`, `HistogramSeries`, `BaselineSeries`, `MarkerOverlay`), a `chart.drawings` facade for 26 drawing kinds, and a `chart.addPane(...)` API for stacked multi-pane layouts. Mobile-first, event-driven, render-on-demand.

This skill is for hosts integrating Carta — Vite/Next/Remix/SvelteKit apps that import from `carta` and need to wire data, layout, and interaction without fighting the library.

## Quick mental model — read this first

Carta inverts the data flow most chart libraries use.

- **You do not push data.** The chart owns a visible window (`startTime`, `endTime`, `intervalDuration`) and emits `data:request` when it sees uncached records inside that window. Your code listens, fetches, and replies via `chart.supplyData(...)`.
- **The window IS the configuration.** Pan/zoom mutate `startTime`/`endTime`. There's no separate "viewport" object. To programmatically pan, call `chart.setWindow({ startTime, endTime })`. To change resolution, call `chart.setInterval(ms)`.
- **Channels scope the cache.** A channel is `{ id: string, kind: 'ohlc' | 'point' | 'marker' }`. Every series binds to one channel id. The cache is per-channel × per-interval. Switching the chart's primary symbol (a fresh `primary` channel id) does NOT flush your indicator caches — they live on different ids (e.g. `sma20`).
- **Render-on-demand.** No ambient ticker. Every state change marks dirty; a single `requestAnimationFrame` flushes. CPU and GPU idle when nothing is happening — this matters on mobile.
- **Mobile gestures are built in.** Pinch zoom, kinetic pan, long-press tracking-mode crosshair, brush-cancels-on-pinch. Don't reinvent them with synthetic touch handlers; use the public API (`enterTrackingMode`, `isKineticActive`, `stopKinetic`).
- **Panes route series, not data.** A series is created against a `channel`; its `paneId` (default `MAIN_PANE_ID`) decides *where* it draws. Add panes via `chart.addPane({ ... })`; route series via `new HistogramSeries({ channel: 'volume', paneId: volumePane.id })`. Don't create one chart per pane — that breaks the shared time axis.
- **Drawings live in data space.** `chart.drawings` owns the model. Anchors are `{ time, price, paneId }` — the renderer projects every frame, so drawings stay pinned across pan / zoom / interval swap. Don't store screen-space coordinates.

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
- `chart.priceScale()` — facade for the **primary pane's `'right'` slot**: `setDomain`, `getDomain`, `setAutoScale`, `isAutoScale`, `setMode`, `getMode`. For other panes / slots use `chart.pane(id).priceScale(scaleId?)`.
- `chart.addPriceRangeProvider(provider)` / `removePriceRangeProvider(provider)` — inject extra ranges into auto-scale (e.g. for drawing tools)
- `PriceScaleMode` is a discriminated union: `{ kind: 'auto' }` | `{ kind: 'manual', min, max }` | `{ kind: 'bounded', min, max, pad? }`. Bounded mode is the canonical recipe for RSI / Stochastic / percent panes.

**Panes (multi-pane layouts)**
- `chart.addPane(opts?)` / `removePane(id)` / `panes()` / `pane(id)` / `primaryPane()`
- `chart.swapPanes(a, b)` (primary stays pinned at index 0); `pane.moveTo(idx)`
- `chart.setPaneHeight(id, px | null)` / `setPaneHidden(id, bool)` / `setPaneCollapsed(id, bool)`
- Per-pane settings via `pane.applyOptions({ height, hidden, collapsed, priceFormatter, priceScales: { right: { mode } } })`
- Headers: `addPane({ header: { title } })` opts in to a 24 px strip with chevron / gear / × cluster (gear emits `pane:settings` for the host's UI)

**Drawings**
- `chart.drawings.beginCreate(kind, options?)` / `cancelCreate()` / `isCreating()`
- `chart.drawings.list()` / `getById(id)` / `add(d)` / `update(id, patch)` / `remove(id)` / `clear()`
- `chart.drawings.select(id | null)` / `toggleSelection(id)` / `getSelectedIds()` / `getPrimarySelectedId()`
- `chart.drawings.getSnapshot()` / `loadSnapshot(snap)` — versioned JSON
- `chart.drawings.attachStorage(adapter, scope)` / `detachStorage()` — adapter contract: `{ load, save, list?, remove? }`
- `chart.getMagnet()` / `setMagnet('off' | 'weak' | 'strong')` — anchor snap mode
- `installHotkeys(chart)` — Alt+T trendline, Alt+H horizontal, …, Alt+Shift+L long position; returns a disposer

**Events**
- `chart.on(event, handler)` / `off` / `once` / `removeAllListeners`
- 20 events:
  - **Core (6):** `window:change`, `interval:change`, `data:request`, `crosshair:move` (now with `paneId`), `tracking:change`, `resize`
  - **Panes (7):** `pane:add`, `pane:remove`, `pane:reorder`, `pane:resize`, `pane:visibility`, `pane:collapse`, `pane:settings`
  - **Drawings (6):** `drawings:created`, `drawings:updated`, `drawings:removed`, `drawings:selected`, `drawing:edit`, `drawing:contextmenu`
  - **Keyboard (1):** `keyboard:hotkey`

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

Every series option type also extends `SeriesPaneRoutingOptions`:

| Field | Default | When to set |
|---|---|---|
| `paneId` | `MAIN_PANE_ID` | Set to a non-primary pane id (returned from `chart.addPane(...)`) to render the series in a separate pane (volume, RSI, MACD, …). |
| `priceScaleId` | `'right'` | Set to `''` (`OVERLAY_SCALE_ID`) for the volume-on-main-pane recipe. Any other string opts into a custom overlay slot. |
| `scaleMargins` | inherits | Per-slot top/bottom fractions. Volume on main pane: `{ top: 0.8, bottom: 0 }`. |

## Multi-pane layouts

```ts
import { TimeSeriesChart, CandlestickSeries, HistogramSeries, LineSeries } from 'carta';

const chart = await TimeSeriesChart.create({ container, startTime, endTime, intervalDuration: 60_000 });
chart.addSeries(new CandlestickSeries({ channel: 'primary' }));   // primary pane

// Volume in its own pane (clean alternative to the bottom-20 % overlay).
const volume = chart.addPane({ stretchFactor: 0.25, header: { title: 'Volume' } });
chart.addSeries(new HistogramSeries({ channel: 'volume', paneId: volume.id }));

// RSI bounded to [0, 100] — the manual price-axis drag stalls at the bound.
const rsi = chart.addPane({
  stretchFactor: 0.25,
  header: { title: 'RSI 14' },
  priceScales: { right: { mode: { kind: 'bounded', min: 0, max: 100 } } },
});
chart.addSeries(new LineSeries({ channel: 'rsi14', paneId: rsi.id, color: 0xa78bfa }));

// Per-pane price formatter — the volume pane gets `12.5K` / `1.4M`.
volume.applyOptions({ priceFormatter: v => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : `${(v/1e3).toFixed(1)}K` });

// Reorder, hide, collapse — all programmatic.
chart.swapPanes(volume.id, rsi.id);
chart.setPaneHidden(volume.id, true);          // hide entirely
chart.setPaneCollapsed(rsi.id, true);          // header-only (24 px)

chart.on('pane:reorder',    e => console.log('order:', e.order));
chart.on('pane:resize',     e => console.log(e.paneId, 'h:', e.height, e.source));
chart.on('pane:visibility', e => console.log(e.paneId, 'hidden?', e.hidden, e.source));
chart.on('pane:collapse',   e => console.log(e.paneId, 'collapsed?', e.collapsed));
chart.on('pane:settings',   e => openPaneSettings(e.paneId));   // gear icon click
```

**Volume-on-main-pane recipe** (no separate pane — volume bars sit in the bottom 20 % of the candle pane):

```ts
chart.addSeries(new HistogramSeries({
  channel: 'volume',
  priceScaleId: '',                            // OVERLAY_SCALE_ID
  scaleMargins: { top: 0.8, bottom: 0 },
  participatesInAutoScale: false,
}));
```

**Pane rules of thumb:**
- The primary pane's id is `MAIN_PANE_ID` (exported); index 0 in `chart.panes()`. It cannot be removed, hidden, or collapsed.
- `swapPanes` / `moveTo` keep primary pinned at index 0 — passing it as either arg is a silent no-op.
- `setPaneCollapsed` is *not* the same as `setPaneHidden`. Collapsed = header visible at 24 px, plot at 0 px. Hidden = pane removed from layout entirely.
- Auto-collapse on narrow viewports kicks in bottom-up with 16 px hysteresis. The auto-collapsed panes emit `pane:visibility{source:'chart-resize'}`, NOT `pane:collapse`.
- A non-primary pane without a header is allowed but the header is the only place to surface the un-collapse control on the chart canvas — use a host-side button if you want a headerless collapsed pane.

## Drawing tools

`chart.drawings` is the facade for **26 drawing kinds**:

`trendline` · `horizontalLine` · `verticalLine` · `rectangle` · `fibRetracement` · `ray` · `extendedLine` · `horizontalRay` · `parallelChannel` · `longPosition` · `shortPosition` · `text` · `callout` · `arrow` · `dateRange` · `priceRange` · `priceDateRange` · `pitchfork` (variants `andrews` / `schiff` / `modifiedSchiff`) · `gannFan` · `ellipse` · `fibExtension` · `fibTimeZones` · `fibFan` · `fibArcs` · `brush` · `icon`

```ts
import { TimeSeriesChart, CandlestickSeries, installHotkeys } from 'carta';

const chart = await TimeSeriesChart.create({ container, startTime, endTime, intervalDuration: 60_000 });
chart.addSeries(new CandlestickSeries({ channel: 'primary' }));

// 1. Hotkeys: Alt+T trendline, Alt+H horizontal, Alt+R rectangle, …
const disposeHotkeys = installHotkeys(chart);

// 2. Programmatic create-mode entry — clicks place anchors.
chart.drawings.beginCreate('trendline');

// 3. Magnet snap to OHLC (great for fibs).
chart.setMagnet('weak');                       // 'off' | 'weak' | 'strong'

// 4. Listen for selection / edit / context-menu.
chart.on('drawings:selected', e => console.log('selected:', e.primary?.kind, '/', e.drawings.length));
chart.on('drawing:edit',       e => openMyEditor(e.drawing));
chart.on('drawing:contextmenu',e => openMyContextMenu(e.drawing, e.screen));

// 5. Persist via your own storage adapter.
chart.drawings.attachStorage({
  async load(scope)         { return JSON.parse(localStorage.getItem(`drawings:${scope.symbol}`) ?? 'null'); },
  async save(scope, snap)   { localStorage.setItem(`drawings:${scope.symbol}`, JSON.stringify(snap)); },
}, { symbol: 'AAPL' });

disposeHotkeys();   // on unmount
```

**Drawing rules of thumb:**
- Anchors are `{ time: Time, price: Price, paneId: PaneId }` — data space, not pixels. `paneId` matters for non-primary panes (a trendline on RSI must carry `paneId: rsiPane.id` or it draws on the primary pane).
- `chart.drawings.add(drawing)` accepts a drawing with `id: ''` (empty string) and the controller will UUID-fill it. Otherwise pass an `asDrawingId(yourId)`.
- `chart.drawings.loadSnapshot(snap)` returns `{ droppedCount, droppedKinds }` — drawings with NaN anchors or unknown `kind` are silently dropped (logged via the chart's `Logger`). Show this count to the user if non-zero.
- `installHotkeys` listens at `document` scope — pass `{ target: chart.container }` if you want chart-only scope. The `keyboard:hotkey` event fires whether or not the helper is installed; call `e.originalEvent.preventDefault()` in your listener to suppress the default `beginCreate` action.
- Brush and pencil drawings simplify with RDP at commit time (`1.5 / dprBucket` CSS px). Don't expect raw pointer history to round-trip through a snapshot.

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
- ❌ **One chart per pane.** Hosts who want "candle on top, volume on bottom" sometimes mount two `TimeSeriesChart` instances. That breaks the shared time axis, doubles GPU contexts, and de-syncs pan / zoom. Use `chart.addPane(...)` and route the volume series with `paneId`.
- ❌ **Storing drawing anchors in screen-space pixels.** Carta projects anchors per frame — pass `{ time, price, paneId }` and they survive pan / zoom / interval-switch. If you want a host-managed annotation that doesn't move with the data, render your own DOM overlay.
- ❌ **Not handling `loadSnapshot`'s drop count.** A schema-versioned JSON loaded from storage may carry kinds your build doesn't know (downgrade) or anchors that fail invariants. The return value is `{ droppedCount, droppedKinds }` — surface non-zero counts to the user instead of silently truncating.
- ❌ **Mounting `installHotkeys` twice.** Each call adds another document-scope listener. Hold the disposer and call it before re-installing (or skip the helper and listen to `keyboard:hotkey` directly).
- ❌ **Setting an unbounded RSI/Stochastic pane.** Auto-scale on a percentage indicator stretches if a single sample is `NaN` or out-of-range. Configure the pane's right scale with `mode: { kind: 'bounded', min: 0, max: 100 }` so manual drag stalls at the bound.

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
Carta doesn't have a built-in indicator engine. Compute the indicator host-side (e.g. SMA, RSI, MACD), feed it through a `LineSeries` / `HistogramSeries` on its own channel id, and route it to its own pane via `paneId` if you want a separate axis. RSI / Stochastic / percent panes should set `priceScales: { right: { mode: { kind: 'bounded', min: 0, max: 100 } } }` on `addPane` so the price axis stays bounded. The plugin architecture for true custom series is on the roadmap (phase 16).

**"How do I add a trendline / fib / position drawing?"**
Use `chart.drawings.beginCreate('trendline' | 'fibRetracement' | 'longPosition' | …)` — subsequent canvas clicks place anchors. Or call `chart.drawings.add(drawing)` to insert one programmatically (anchors in `{ time, price, paneId }` data space). Wire `installHotkeys(chart)` for the standard Alt+letter bindings.

**"How do I add a separate volume / RSI / MACD pane?"**
`const p = chart.addPane({ stretchFactor: 0.25, header: { title: 'Volume' } })` then `chart.addSeries(new HistogramSeries({ channel: 'volume', paneId: p.id }))`. For volume on the *same* pane as candles, use `priceScaleId: ''` + `scaleMargins: { top: 0.8, bottom: 0 }`.

**"How do I export the chart as PNG?"**
Not in v0. Roadmap phase 15. For now, if you really need it, grab the canvas via the container DOM tree and call `canvas.toBlob('image/png')` yourself. The chart constructor passes `preserveDrawingBuffer: true` so the canvas is captureable.

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

If the user asks for something not covered (plugin custom series, save / load + PNG export, accessibility-beyond-basic), tell them: **"That's on the Carta roadmap (phase 15–17) but not shipped yet. For now, do X workaround."** Don't pretend an API exists. Drawing tools (phase 13) and multi-pane layouts (phase 14) ARE shipped — see the dedicated sections above.

## Status of this skill

Targets Carta `v0.0` (pre-1.0) — phases 1–14 shipped (drawing tools + multi-pane layouts inclusive). API may change minorly before v1; pin exact versions in production. Update this skill when:

- A new public method lands on `TimeSeriesChart`, `Pane`, or `chart.drawings`
- A new event is added to `CartaEventMap` (or a payload field changes)
- A new series class, drawing kind, or theme token ships
- A method is renamed (capture in the anti-patterns list above)

The Carta repo's `plans/master-plan.md` is the canonical roadmap.
