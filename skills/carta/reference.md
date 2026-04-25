# Carta — full API reference

Loaded on demand by the `carta` skill. Mirrors the README but with every option, every event payload, every series option type spelled out — no hand-waving.

## `TimeSeriesChart`

### Construction

```ts
static TimeSeriesChart.create(options: TimeSeriesChartConstructionOptions): Promise<TimeSeriesChart>
```

`TimeSeriesChartConstructionOptions` extends `TimeSeriesChartOptions`. The extra fields (`timeAxis`, `priceAxisDrag`, `dprListenerHooks`) are niche / test-only — most hosts pass plain `TimeSeriesChartOptions`.

```ts
interface TimeSeriesChartOptions {
  readonly container: HTMLElement;             // host element — must have layout dims
  readonly startTime: Time | number;            // ms epoch
  readonly endTime:   Time | number;
  readonly intervalDuration: Interval | number; // ms per bar (60_000 = 1m)
  readonly width?:  number;                     // override container size
  readonly height?: number;
  readonly autoResize?: boolean;                // default: true
  readonly devicePixelRatio?: number;           // default: window.devicePixelRatio (snapped to {1,1.5,2})
  readonly theme?: Partial<Theme>;              // default: DarkTheme
  readonly logger?: Logger;                     // default: noopLogger
  readonly viewport?: ViewportOptions;          // pan/zoom limits + kinetic
  readonly priceScale?: PriceScaleOptions;      // margins
  readonly priceAxis?:  PriceAxisOptions;       // label fonts + width
  readonly priceFormatter?: (n: number) => string;
  readonly data?: DataOptions;                  // cache caps + request thresholds
}
```

### Lifecycle

| Method | Returns | Notes |
|---|---|---|
| `destroy()` | `void` | Drops GPU context, removes listeners, clears canvas. Required in framework cleanup. |

### Window & interval

| Method | Returns |
|---|---|
| `setWindow({ startTime, endTime })` | `void` — fires `window:change` |
| `getWindow()` | `ChartWindow` |
| `getInterval()` | `Interval` |
| `setInterval(intervalDuration: Interval \| number)` | `void` — fires `interval:change`; **invalidates the previous interval bucket per channel**; may fire `data:request` for the new resolution |
| `resize(width: number, height: number)` | `void` — manual; auto-resize is on by default |

### Data & cache

| Method | Returns |
|---|---|
| `defineChannel({ id, kind })` | `void` — pre-registers; `addSeries` auto-defines |
| `supplyData(channelId, intervalDuration, records)` | `void` — sorted + de-duped by `time` |
| `supplyTick(channelId, record, intervalDuration?)` | `void` — replaces same-time bar if present |
| `clearCache({ channelId?, intervalDuration? })` | `void` — surgical or full flush |
| `cacheStats()` | `readonly CacheStats[]` |
| `recordsInRange(channelId, intervalDuration, startTime, endTime)` | `readonly DataRecord[]` |
| `missingRanges(channelId, query?)` | `readonly Range[]` |
| `hasPendingDataRequest()` | `boolean` |

### Series

| Method | Returns |
|---|---|
| `addSeries<S extends Series>(series: S)` | `S` (the same instance, for chaining) |
| `removeSeries(series: Series)` | `boolean` |

### Interaction

| Method | Returns |
|---|---|
| `enterTrackingMode({ time?, price? })` | `void` — fires `tracking:change{active:true}` if transitioned |
| `exitTrackingMode()` | `void` — fires `tracking:change{active:false}` if transitioned |
| `isTrackingMode()` | `boolean` |
| `isKineticActive()` | `boolean` |
| `stopKinetic()` | `void` |

### Theme & price scale

| Method | Returns |
|---|---|
| `applyOptions({ theme?, priceFormatter? })` | `void` — shallow merge |
| `priceScale()` | `PriceScaleFacade` |
| `addPriceRangeProvider(provider)` | `void` |
| `removePriceRangeProvider(provider)` | `void` |
| `visiblePriceTicks()` | `readonly PriceTickInfo[]` |

### Events

| Method | Returns |
|---|---|
| `on(event, handler)` | `void` — typed; handler param infers from event key |
| `off(event, handler)` | `void` |
| `once(event, handler)` | `void` |
| `removeAllListeners()` | `void` |

### Introspection (advanced — debug-oriented, shape may change before v1)

| Method | Returns |
|---|---|
| `barsInWindow()` | `readonly Time[]` |
| `visibleTicks()` | `readonly TickInfo[]` |
| `priceAxisPoolSize()` / `axisPoolSize()` | `number` — pool retention counters |
| `__debugStats()` | structural — `{ seriesRenderCount, crosshair, tracking, dpr }` |

## Events catalog

```ts
interface CartaEventMap {
  'window:change':   ChartWindow;          // pan/zoom/setWindow/setInterval — debounced
  'interval:change': IntervalChange;       // after setInterval — previous bucket invalidated
  'data:request':    DataRequest;          // visible window has uncached records
  'crosshair:move':  CrosshairInfo;        // pointer move OR programmatic tracking-mode update
  'tracking:change': TrackingChange;       // long-press OR enterTrackingMode/exitTrackingMode
  'resize':          SizeInfo;             // container dimensions changed
}
```

### `ChartWindow`
```ts
{ startTime: Time; endTime: Time; intervalDuration: Interval }
```

### `IntervalChange`
```ts
{ previous: Interval | null; current: Interval }
```

### `DataRequest`
```ts
{
  channelId: string;
  kind: 'ohlc' | 'point' | 'marker';
  intervalDuration: Interval;
  startTime: Time;
  endTime: Time;
}
```

### `CrosshairInfo`
```ts
{
  time:  Time | null;                                 // null on leave
  price: Price | null;                                // null on leave
  point: { x: Pixel; y: Pixel };                      // last known pixel coord, preserved on leave
  seriesData: ReadonlyMap<CrosshairSeriesKey, DataRecord | null>;
}
```

`seriesData` is keyed by the host's own `Series` instance reference (the same object passed to `chart.addSeries`). Iterate to render per-series legends.

### `TrackingChange`
```ts
{ active: boolean }
```

Idempotent — re-entering tracking mode while active does NOT fire. `destroy()` does NOT emit a final `false`.

### `SizeInfo`
```ts
{ width: number; height: number }
```

## Data record types

```ts
interface OhlcRecord {
  readonly time:    Time;
  readonly open:    Price;
  readonly high:    Price;
  readonly low:     Price;
  readonly close:   Price;
  readonly volume?: number;
}

interface PointRecord {
  readonly time:    Time;
  readonly value:   Price;
  readonly color?:  number;
}

interface MarkerRecord {
  readonly time:     Time;
  readonly position: 'above' | 'below' | 'inBar';
  readonly shape:    'circle' | 'square' | 'arrowUp' | 'arrowDown';
  readonly color?:   number;
  readonly text?:    string;
}
```

Records are immutable from the chart's perspective — Carta sorts by `time` and de-dupes by `(channel, interval, time)`, never mutates.

## Branded types

```ts
type Time     = number & { readonly __brand: 'Time' };
type Interval = number & { readonly __brand: 'Interval' };
type Pixel    = number & { readonly __brand: 'Pixel' };
type Price    = number & { readonly __brand: 'Price' };

const asTime:     (n: number) => Time;
const asInterval: (n: number) => Interval;
const asPixel:    (n: number) => Pixel;
const asPrice:    (n: number) => Price;
```

Public input methods accept `Time | number`, `Interval | number`, etc. — pass plain numbers. Output methods preserve the brand. Arithmetic and `Number()` cast work without explicit unbrand.

## Theme

```ts
interface Theme {
  // Surface
  background: number;
  grid:       number;
  gridAlpha:  number;       // 1.0 dark, 0.6 light — multiplied with grid stroke alpha
  frame:      number;

  // Text
  text:      number;
  textMuted: number;

  // Series defaults
  up:                       number;
  down:                     number;
  line:                     number;
  areaTop:                  number;
  areaBottom:               number;
  histogramUp:              number;
  histogramDown:            number;
  baselinePositiveTop:      number;
  baselinePositiveBottom:   number;
  baselineNegativeTop:      number;
  baselineNegativeBottom:   number;

  // Crosshair
  crosshairLine:    number;
  crosshairTagBg:   number;
  crosshairTagText: number;

  // Typography
  fontFamily: string;
  fontSize:   number;
}
```

Two presets are exported: `DarkTheme` (default), `LightTheme`. Pass `Partial<Theme>` to override.

Per-series colour options always beat theme values (e.g. `new CandlestickSeries({ upColor: 0xff00ff })` overrides `theme.up`).

## Series options — full

### `CandlestickSeriesOptions`
```ts
{
  channel:     string;          // required
  upColor?:    number;          // default: theme.up
  downColor?:  number;          // default: theme.down
  wickWidth?:  number;          // default: 1
  bodyGapPx?:  number;          // default: 1 — horizontal padding between adjacent bodies
}
```

### `OhlcBarSeriesOptions`
```ts
{
  channel:    string;
  upColor?:   number;
  downColor?: number;
  tickWidth?: number;            // default: 1
  thinBars?:  boolean;           // default: false — force every stroke to 1 px (overrides tickWidth)
}
```

### `HeikinAshiSeriesOptions`
Same shape as `CandlestickSeriesOptions`. The series carries a small internal cache so HA smoothing survives pan/zoom — call `setQueryContext(query)` if you're integrating in an unusual way (rare).

### `LineSeriesOptions`
```ts
{
  channel:    string;
  color?:     number;            // default: theme.line
  lineWidth?: number;            // default: 1.5
  lineStyle?: 'solid' | 'dashed' | 'dotted';   // default: 'solid'
  lineType?:  'simple' | 'stepped';            // default: 'simple'
}
```

### `AreaSeriesOptions`
```ts
{
  channel:      string;
  topColor?:    number;          // default: theme.areaTop
  bottomColor?: number;          // default: theme.areaBottom
  topAlpha?:    number;          // default: 0.45
  bottomAlpha?: number;          // default: 0
  lineColor?:   number;          // default: topColor
  lineWidth?:   number;
  baseline?:    number;          // default: visible bottom of price scale
}
```

### `HistogramSeriesOptions`
```ts
{
  channel:                  string;
  color?:                   number;     // default: theme.line
  base?:                    number;     // default: 0 — bars grow from this price
  participatesInAutoScale?: boolean;    // default: true — set false for volume overlays!
}
```

### `BaselineSeriesOptions`
```ts
{
  channel:                 string;
  baseline?:               number | 'first' | 'average';   // default: 0
  positiveTopColor?:       number;
  positiveBottomColor?:    number;
  negativeTopColor?:       number;
  negativeBottomColor?:    number;
  fillTopAlpha?:           number;     // default: 0.45
  fillBottomAlpha?:        number;     // default: 0.05
  lineColor?:              number;
  lineWidth?:              number;
}
```

### `MarkerOverlayOptions`
```ts
{
  channel: string;
  priceReference: {
    channel: string;                              // ohlc or point channel id
    field?:  'high' | 'low' | 'close' | 'value';  // for above/below positions
  };
  defaultColor?:    number;        // default: theme.line
  defaultSize?:     number;        // default: 12 px (radius/half-side/half-height)
  textFontFamily?:  string;        // default: 'Arial'
  textFontSize?:    number;        // default: 11
}
```

## Viewport options

```ts
interface ViewportOptions {
  minIntervalDuration?: number;   // pixel width below which we stop zooming in
  maxWindowDuration?:   number;   // ms cap on window span
  zoomFactor?:          number;   // wheel zoom multiplier per notch
  shiftPanFraction?:    number;   // shift+arrow keys pan fraction
  kinetic?: {
    decayPerSec?:              number;     // velocity decay (default ~5)
    minFlingVelocityPxPerMs?:  number;     // below this, no kinetic on release
  };
}
```

## Price scale options

```ts
interface PriceScaleOptions {
  margins?: { top: number; bottom: number };   // 0..1 fractions
  mode?: 'linear';                              // only mode in v0
}

interface PriceScaleFacade {
  setDomain(min: Price | number, max: Price | number): void;
  getDomain(): { min: Price; max: Price };
  isAutoScale(): boolean;
  setAutoScale(on: boolean): void;
}
```

## Logger contract

```ts
interface Logger {
  debug(msg: string, ...args: readonly unknown[]): void;
  info(msg: string, ...args: readonly unknown[]): void;
  warn(msg: string, ...args: readonly unknown[]): void;
  error(msg: string, ...args: readonly unknown[]): void;
}
```

The default `noopLogger` does nothing. Pass your own to capture diagnostics.

## Data caching options

```ts
interface DataOptions {
  caps?: {
    ohlc?:   number;     // max records per (channel × interval) bucket for ohlc kinds
    point?:  number;
    marker?: number;
  };
  requestThresholdBars?: number;  // request fires when uncached span ≥ this many bars
}
```

When a cap is hit, oldest records are evicted by `time`. Caps default to large values; only tune for memory-constrained hosts (mobile, low-end laptops).

## Cross-references

For broader integration patterns (React/Vue/Svelte/SSR, websocket, multi-chart dashboards, drawing-tool stubs), see [examples.md](examples.md).
