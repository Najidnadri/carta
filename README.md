[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)](#status)
[![Peer dep: pixi.js v8](https://img.shields.io/badge/peer--dep-pixi.js%20%5E8.0.0-ff69b4.svg)](https://pixijs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)

# Carta

Carta is a GPU-accelerated charting library for time-series data, built on PixiJS v8. One primary class, `TimeSeriesChart`. You hand it a visible window (`startTime`, `endTime`, `intervalDuration`); it asks you for data via events; it caches what you supply so re-visited windows never refetch. Mobile gestures, kinetic pan, and a long-press tracking crosshair are first-class — not bolted on.

> ⚠ **Carta is pre-1.0 (`v0.0`).** The public API documented here is stable enough for prototyping, but minor breaking changes can land before v1. Pin exact versions if you depend on internals.

---

## Install

```sh
pnpm add carta pixi.js
# or: npm install carta pixi.js
# or: yarn add carta pixi.js
```

`pixi.js` v8 is a **peer dependency** — Carta does not bundle it, so the host stays in control of the Pixi version (and so multiple Pixi-based libraries don't double-load the runtime).

---

## Quickstart

A minimum chart with one candlestick series and a backend handler:

```ts
import { TimeSeriesChart, CandlestickSeries } from 'carta';
import type { OhlcRecord, DataRequest } from 'carta';

const container = document.getElementById('chart')!;
const now = Date.now();

const chart = await TimeSeriesChart.create({
  container,
  startTime: now - 200 * 60_000,   // 200 minutes ago
  endTime:   now,
  intervalDuration: 60_000,        // 1-minute bars
});

chart.addSeries(new CandlestickSeries({ channel: 'primary' }));

chart.on('data:request', async (req: DataRequest) => {
  // replace with your data fetcher (REST, websocket, etc.)
  const bars: OhlcRecord[] = await myBackend.fetchOhlc(req);
  chart.supplyData(req.channelId, req.intervalDuration, bars);
});
```

`TimeSeriesChart.create()` is **async** — it boots the WebGL/WebGPU renderer before returning. The `data:request` event fires whenever the visible window includes records the chart hasn't seen yet for a given channel; respond with `chart.supplyData(...)` and the chart redraws on the next frame.

---

## Multi-channel example

A realistic wiring with a primary OHLC series, an SMA-20 line overlay, a volume histogram, and event markers — each backed by its own channel and its own cache:

```ts
import {
  TimeSeriesChart,
  CandlestickSeries, LineSeries, HistogramSeries, MarkerOverlay,
} from 'carta';
import type {
  OhlcRecord, PointRecord, MarkerRecord, DataRequest,
} from 'carta';

const chart = await TimeSeriesChart.create({
  container: document.getElementById('chart')!,
  startTime: Date.now() - 200 * 60_000,
  endTime:   Date.now(),
  intervalDuration: 60_000,
});

chart.addSeries(new CandlestickSeries({ channel: 'primary' }));
chart.addSeries(new LineSeries({ channel: 'sma20', color: 0x58a6ff, lineWidth: 1.5 }));
chart.addSeries(new HistogramSeries({
  channel: 'volume',
  participatesInAutoScale: false,
}));
chart.addSeries(new MarkerOverlay({
  channel: 'events',
  priceReference: { channel: 'primary', field: 'high' },
}));

chart.on('data:request', async (req: DataRequest) => {
  switch (req.channelId) {
    case 'primary': {
      const bars: OhlcRecord[] = await myBackend.fetchOhlc(req);
      chart.supplyData('primary', req.intervalDuration, bars);
      break;
    }
    case 'sma20': {
      const points: PointRecord[] = await myBackend.fetchSma(req, 20);
      chart.supplyData('sma20', req.intervalDuration, points);
      break;
    }
    case 'volume': {
      const points: PointRecord[] = await myBackend.fetchVolume(req);
      chart.supplyData('volume', req.intervalDuration, points);
      break;
    }
    case 'events': {
      const marks: MarkerRecord[] = await myBackend.fetchEvents(req);
      chart.supplyData('events', req.intervalDuration, marks);
      break;
    }
  }
});

// Optional: live ticks merge into the per-channel cache.
chart.supplyTick('primary', latestOhlc);
chart.supplyTick('volume',  latestVolumePoint);
```

---

## Concepts

### Visible window
`startTime`, `endTime`, and `intervalDuration` are *the* viewport. Mutating either via `setWindow()` or `setInterval()` pans, zooms, or changes resolution — and a `window:change` (and possibly `interval:change`) event fires so the host can reflect the new state. There is no separate "viewport" object the host mutates; the window IS the configuration.

### Channels
A channel is an addressable stream of one record kind. Series construct against a channel id (e.g. `new CandlestickSeries({ channel: 'primary' })`). The cache is **per-channel** — switching a chart's primary symbol (a fresh `primary` channel) does not flush your indicator caches, because each indicator lives on its own channel id.

The chart auto-defines channels when a series is added; you can also call `defineChannel({ id, kind })` ahead of time if you want to seed the cache via `supplyData()` before any series exists.

### Render-on-demand
Carta does not run an ambient ticker. Every mutation marks the scene dirty; a single `requestAnimationFrame` flushes the dirty set and renders once. CPU and GPU are idle when nothing is happening — important on battery and on mobile.

### Tracking mode
On touch devices, a long-press anywhere on the plot enters **tracking mode**: the crosshair pins to the touched bar and follows your finger as you drag, without panning the chart. Tap outside (or call `exitTrackingMode()`) to leave. The `tracking:change` event fires on every transition.

---

## API reference

### `TimeSeriesChart`

#### Construction & lifecycle

| Method | Description |
|---|---|
| `static create(options: TimeSeriesChartConstructionOptions)` | Async constructor. Returns `Promise<TimeSeriesChart>`. Boots the renderer and mounts a canvas inside `options.container`. |
| `destroy()` | Tear down GPU resources, listeners, and the canvas. After this, the instance is unusable. |

`TimeSeriesChartConstructionOptions` extends `TimeSeriesChartOptions` with two niche fields (`timeAxis`, `priceAxisDrag`) and a test-only DPR hook. The host-facing options that matter are below — see [`src/types.ts`](src/types.ts) for the full interface:

| Option | Type | Default | Description |
|---|---|---|---|
| `container` | `HTMLElement` | required | Element to mount the canvas into. |
| `startTime` | `Time \| number` | required | Left edge of the visible window (ms epoch). |
| `endTime` | `Time \| number` | required | Right edge of the visible window. |
| `intervalDuration` | `Interval \| number` | required | Bar duration in ms (e.g. `60_000` for 1m). |
| `width` / `height` | `number` | container size | Override canvas size. |
| `autoResize` | `boolean` | `true` | Resize on container size changes. |
| `devicePixelRatio` | `number` | `window.devicePixelRatio` | DPR override (snaps to `{1, 1.5, 2}` internally). |
| `theme` | `Partial<Theme>` | `DarkTheme` | Visual constants (see Themes below). |
| `logger` | `Logger` | `noopLogger` | Diagnostic sink — Carta never `console.log`s. |
| `viewport` | `ViewportOptions` | sensible | Min/max zoom, kinetic decay, etc. |
| `priceScale` / `priceAxis` | option objects | sensible | Margins, label widths. |
| `priceFormatter` | `(n: number) => string` | `defaultPriceFormatter` | Tick label format. |
| `data` | `DataOptions` | sensible | Per-kind cache caps, request thresholds. |

#### Window & interval

| Method | Description |
|---|---|
| `setWindow(win: WindowInput)` | Pan or zoom by setting both edges. Fires `window:change`. |
| `getWindow(): ChartWindow` | Snapshot of `{ startTime, endTime, intervalDuration }`. |
| `getInterval(): Interval` | Current bar duration. |
| `setInterval(intervalDuration)` | Switch resolution. **Invalidates the previous interval's cache bucket** (per-channel); other intervals are preserved. Fires `interval:change` and may fire `data:request` for the new resolution. |
| `resize(width, height)` | Manual resize. Auto-resize is on by default; call this only if you've turned it off. |

#### Data & cache

| Method | Description |
|---|---|
| `defineChannel(channel: Channel)` | Pre-register a channel. Optional — `addSeries()` auto-defines. |
| `supplyData(channelId, intervalDuration, records)` | Respond to a `data:request`. Records can be in any order; Carta sorts and de-dupes by `time`. |
| `supplyTick(channelId, record, intervalDuration?)` | Live update. Merged into the cache, replaces a same-time bar if one already exists. |
| `clearCache(opts?)` | Clear all caches, or a single channel, or a single `(channel, interval)` bucket. |
| `cacheStats(): readonly CacheStats[]` | Inspect what's loaded — channel id, kind, intervals loaded, total record count. |
| `recordsInRange(channelId, intervalDuration, startTime, endTime)` | Read what the cache currently holds for a window. |
| `missingRanges(channelId, query?)` | Compute which sub-ranges of the visible window are still uncached for a channel. |
| `hasPendingDataRequest(): boolean` | True if a `data:request` is in flight (the host hasn't called `supplyData()` yet). |

#### Series

| Method | Description |
|---|---|
| `addSeries(series): typeof series` | Attach a series. Returns the series for chaining. |
| `removeSeries(series): boolean` | Detach. Returns `true` if found. |

#### Interaction

| Method | Description |
|---|---|
| `enterTrackingMode(opts?: TrackingModeOptions)` | Programmatically enter tracking mode at an optional `(time, price)`. Fires `tracking:change` if it transitioned. |
| `exitTrackingMode()` | Leave tracking mode. |
| `isTrackingMode(): boolean` | Current state. |
| `isKineticActive(): boolean` | True while a flick is decaying. |
| `stopKinetic()` | Cancel an in-flight kinetic pan. |

#### Price scale

| Method | Description |
|---|---|
| `priceScale(): PriceScaleFacade` | Direct handle to the active scale: `setDomain()`, `getDomain()`, `setAutoScale()`, `isAutoScale()`. |
| `applyOptions({ theme?, priceFormatter? })` | Patch theme constants or the tick formatter. Shallow-merges; per-series colours still win. |
| `addPriceRangeProvider(provider)` | Inject an extra price range into auto-scale (e.g., a horizontal-line drawing). |
| `removePriceRangeProvider(provider)` | Detach. |
| `visiblePriceTicks(): readonly PriceTickInfo[]` | Read the currently rendered Y-axis ticks. |

#### Event subscription

| Method | Description |
|---|---|
| `on(event, handler)` | Register. Typed — handler param infers from event key. |
| `off(event, handler)` | Unregister a specific handler. |
| `once(event, handler)` | One-shot. |
| `removeAllListeners()` | Drop everything. |

See the [Events](#events) section below for the catalog of event keys and payload shapes.

<details>
<summary>Introspection (advanced — debug-oriented, shape may change before v1)</summary>

| Method | Description |
|---|---|
| `barsInWindow(): readonly Time[]` | Bar centroid timestamps currently visible. |
| `visibleTicks(): readonly TickInfo[]` | X-axis ticks currently rendered. |
| `priceAxisPoolSize()` / `axisPoolSize()` | Pool retention counters for axis labels. |
| `__debugStats()` | Aggregate counters (series renders, crosshair / tracking / DPR state). The leading `__` and the structural return type signal "not contract". |

</details>

---

### Series classes

All series share a common shape: a constructor that takes a `channel` id plus visual options, an `applyOptions(patch)` that shallow-merges runtime tweaks, and a `destroy()` that releases pool resources. Add via `chart.addSeries(new Foo(...))`; remove via `chart.removeSeries(foo)`.

#### `CandlestickSeries`
Hollow/filled body with high-low wick. Consumes the `ohlc` channel kind.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | Channel id. |
| `upColor` / `downColor` | `number` | `theme.up` / `theme.down` | Body colors. |
| `wickWidth` | `number` | `1` | Stroke px for the high-low line. |
| `bodyGapPx` | `number` | `1` | Horizontal padding between adjacent bodies. |

#### `OhlcBarSeries`
Vertical wick with left tick (open) and right tick (close). Consumes `ohlc`.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | Channel id. |
| `upColor` / `downColor` | `number` | theme | Per-direction tint. |
| `tickWidth` | `number` | `1` | Stroke px for vertical and tick lines. |
| `thinBars` | `boolean` | `false` | Force every stroke to 1 px (overrides `tickWidth`). Useful in dense windows. |

#### `HeikinAshiSeries`
Smoothed candles whose open/close are derived from the prior HA bar. Consumes `ohlc`. Same options as `CandlestickSeries`. Carries a small internal cache so the smoothing chain survives pan/zoom.

#### `LineSeries`
Polyline through point records. Consumes `point`.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | Channel id. |
| `color` | `number` | `theme.line` | Stroke color. |
| `lineWidth` | `number` | `1.5` | Stroke px. |
| `lineStyle` | `'solid' \| 'dashed' \| 'dotted'` | `'solid'` | Dash pattern. |
| `lineType` | `'simple' \| 'stepped'` | `'simple'` | `'stepped'` holds value until next x. |

#### `AreaSeries`
Polyline + gradient fill to a baseline. Consumes `point`.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | |
| `topColor` / `bottomColor` | `number` | theme | Gradient stops. |
| `topAlpha` / `bottomAlpha` | `number` | `0.45` / `0` | |
| `lineColor` / `lineWidth` | | | Stroke on top of fill. |
| `baseline` | `number` | visible bottom | Price the fill grows to. |

#### `HistogramSeries`
Vertical bars from a `base` price up/down to each point's `value`. Consumes `point`. Per-record `color` overrides `color`.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | |
| `color` | `number` | `theme.line` | Default bar color. |
| `base` | `number` | `0` | Bars grow from this price. |
| `participatesInAutoScale` | `boolean` | `true` | Volume overlays on a shared price scale should set this `false`. |

#### `BaselineSeries`
Two-tone area: positive segment (above baseline) and negative segment (below). Consumes `point`.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | |
| `baseline` | `number \| 'first' \| 'average'` | `0` | Numeric, or computed from visible finite values. |
| `positiveTopColor` / `positiveBottomColor` | `number` | theme | Above-baseline gradient. |
| `negativeTopColor` / `negativeBottomColor` | `number` | theme | Below-baseline gradient. |
| `fillTopAlpha` / `fillBottomAlpha` | `number` | `0.45` / `0.05` | Gradient alphas. |
| `lineColor` / `lineWidth` | | | Polyline stroke. |

#### `MarkerOverlay`
Sparse glyphs (circle / square / arrowUp / arrowDown) anchored to a price. Consumes `marker`. Conceptually an overlay, but added with `chart.addSeries()` like any other series.

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `string` | required | Marker channel id. |
| `priceReference` | `{ channel, field? }` | required | Channel that supplies the Y anchor (e.g., `{ channel: 'primary', field: 'high' }`). |
| `defaultColor` | `number` | `theme.line` | Glyph tint when record has no `color`. |
| `defaultSize` | `number` | `12` | Radius / half-side / half-height in CSS px. |
| `textFontFamily` / `textFontSize` | | | Marker label typography. |

---

### Themes

Carta ships with two themes:

- **`DarkTheme`** — default. Dark surface, bright series defaults.
- **`LightTheme`** — paper-like surface, restrained alpha.

Both implement the `Theme` interface in [`src/types.ts`](src/types.ts). Construct with `theme: Partial<Theme>` to override individual constants, or call `chart.applyOptions({ theme })` at runtime to swap. Per-series colour options always beat theme values.

```ts
import { TimeSeriesChart, LightTheme } from 'carta';

const chart = await TimeSeriesChart.create({
  /* ... */
  theme: { ...LightTheme, gridAlpha: 0.4 },  // light, with extra-soft gridlines
});

chart.applyOptions({ theme: { background: 0x0a0e14 } });   // patch later
```

---

## Events

Listeners are typed end-to-end — `chart.on('window:change', h)` infers `h` as `(payload: ChartWindow) => void`.

| Event | Payload | Fires when |
|---|---|---|
| `window:change` | `ChartWindow` | Pan, zoom, `setWindow()`, or `setInterval()` settles. Debounced through the dirty queue. |
| `interval:change` | `IntervalChange` | After `setInterval()`. The previous-interval cache bucket has been invalidated. |
| `data:request` | `DataRequest` | The visible window contains records the chart hasn't seen for a channel. Respond with `supplyData()`. |
| `crosshair:move` | `CrosshairInfo` | Pointer moves over the plot, OR programmatic tracking-mode update. On leave, `time` / `price` are `null` but the last `point` is preserved. |
| `tracking:change` | `TrackingChange` | Long-press start / end OR `enterTrackingMode()` / `exitTrackingMode()`. Idempotent calls do not fire. |
| `resize` | `SizeInfo` | Container dimensions changed. |

Payload type definitions live in [`src/types.ts`](src/types.ts) and are re-exported from the package entry — `import type { ChartWindow } from 'carta'`.

---

## Data record types

Every channel carries one of three record shapes, declared by the channel's `kind`:

```ts
interface OhlcRecord {
  readonly time: Time;             // ms epoch, aligned to intervalDuration
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume?: number;        // optional; lets a histogram piggy-back without a 2nd fetch
}

interface PointRecord {
  readonly time: Time;
  readonly value: Price;
  readonly color?: number;         // per-point override (e.g. red volume bars on down candles)
}

interface MarkerRecord {
  readonly time: Time;
  readonly position: 'above' | 'below' | 'inBar';
  readonly shape:    'circle' | 'square' | 'arrowUp' | 'arrowDown';
  readonly color?: number;
  readonly text?:  string;
}

type DataRecord = OhlcRecord | PointRecord | MarkerRecord;
```

Records are immutable from the chart's perspective — Carta sorts them by `time` and de-dupes by `(channel, interval, time)`, but never mutates the array you pass.

---

## Branded types

Carta uses TypeScript **branded types** for unit-bearing numbers — `Time` (ms epoch), `Interval` (ms per bar), `Pixel` (CSS px), `Price`. They prevent accidentally subtracting a `Price` from a `Time` at compile time, with zero runtime cost.

On **input**, every public method accepts the union — pass plain numbers, no cast required:

```ts
chart.setWindow({ startTime: Date.now() - 3_600_000, endTime: Date.now() });
chart.setInterval(60_000);  // plain number, fine
```

On **output** (e.g. `getWindow()`, `crosshair:move` payloads), the brand is preserved. Arithmetic and assignment back to `number` works without any explicit cast:

```ts
chart.on('window:change', (win) => {
  const minutes = (win.endTime - win.startTime) / 60_000;
  console.log(`window is ${minutes} minutes wide`);
});
```

If you need to construct a branded value explicitly, the `asTime`, `asInterval`, `asPixel`, `asPrice` helpers are exported.

---

## Status

### Shipped in `v0.0`

- **Series:** candlestick, OHLC bar, Heikin-Ashi, line (solid / dashed / dotted, simple / stepped), area, histogram, baseline (two-tone area), marker overlay.
- **Themes:** `DarkTheme` (default) + `LightTheme`, swappable at runtime.
- **Interaction:** wheel and pinch zoom, drag-and-fling kinetic pan, two-finger pan, long-press tracking-mode crosshair, tap-outside dismiss.
- **Mobile:** DPR snap to `{1, 1.5, 2}`, `matchMedia` listener for DPR transitions, 44px tap targets in the demo.
- **Price scale:** auto-scale + manual override, per-series margin overrides, drag-to-stretch on the price strip.
- **Cache:** per-channel × per-interval, deterministic invalidation on `setInterval`.
- **Events:** typed bus with 6 event keys, `on` / `off` / `once` / `removeAllListeners`.
- **Render:** dirty-flag queue, single `requestAnimationFrame` flush, no ambient ticker.

### On the roadmap

- **Phase 12 — Testing.** Vitest + Playwright smoke + visual diff.
- **Phase 13 — Drawing tools.** Trendlines, fibs, channels.
- **Phase 14 — Multi-pane layouts.** Separate panes for indicators on their own price axes.
- **Phase 15 — Save / load + PNG export.**
- **Phase 16 — Plugin architecture.** Custom series + indicator engine.
- **Phase 17 — Accessibility beyond basic.**

### Not planned (out of scope)

- **Indicator engine** (MA, RSI, MACD, …) — hosts can build via the phase-16 plugin API.
- **Log / percent / inverted price scales** — linear only.
- **Compare / multi-symbol overlays.**
- **Sonification of series** — plugin territory.
- **Server-side / SVG export** — Pixi is canvas; SVG is a host-side render.

---

## Philosophy

One class. Event-driven: you don't push data, the chart asks you for it. Mobile-first: pinch, kinetic drag, and long-press tracking are not afterthoughts. No half-finished features — every shipped capability is wired end-to-end across desktop and touch, or it's not in the build.

---

## License

MIT — see [LICENSE](LICENSE).
