# Carta — extended examples

Loaded on demand by the `carta` skill. Real-world integration patterns the SKILL.md is too short to cover.

## 1. Reusable React hook

```ts
// useCartaChart.ts
import { useEffect, useRef } from 'react';
import { TimeSeriesChart, CandlestickSeries } from 'carta';
import type { DataRequest, OhlcRecord } from 'carta';

interface UseCartaChartOpts {
  fetchOhlc: (req: DataRequest) => Promise<OhlcRecord[]>;
  startTime: number;
  endTime: number;
  intervalDuration: number;
}

export function useCartaChart(opts: UseCartaChartOpts) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<TimeSeriesChart | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    (async () => {
      const chart = await TimeSeriesChart.create({
        container: containerRef.current!,
        startTime: opts.startTime,
        endTime: opts.endTime,
        intervalDuration: opts.intervalDuration,
      });
      if (cancelled) { chart.destroy(); return; }

      chartRef.current = chart;
      chart.addSeries(new CandlestickSeries({ channel: 'primary' }));
      chart.on('data:request', async req => {
        const bars = await opts.fetchOhlc(req);
        chart.supplyData(req.channelId, req.intervalDuration, bars);
      });
    })();

    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);  // mount only — see prop-driven mutations below

  return { containerRef, chart: chartRef };
}
```

Then drive prop changes through the chart's mutation methods, not by recreating:

```tsx
function ChartPage({ symbol, interval }: { symbol: string; interval: number }) {
  const { containerRef, chart } = useCartaChart({ /* ... */ });

  useEffect(() => {
    chart.current?.clearCache({ channelId: 'primary' });
  }, [symbol]);

  useEffect(() => {
    if (chart.current) chart.current.setInterval(interval);
  }, [interval]);

  return <div ref={containerRef} style={{ width: '100%', height: 480 }} />;
}
```

## 2. Websocket live feed with reconnection

```ts
function attachWebsocket(chart: TimeSeriesChart, url: string) {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  let alive = true;

  const open = () => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => { reconnectDelay = 1000; });
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'tick')   chart.supplyTick(msg.channelId, msg.record);
      if (msg.type === 'replay') chart.supplyData(msg.channelId, msg.intervalDuration, msg.records);
    });
    ws.addEventListener('close', () => {
      if (!alive) return;
      setTimeout(open, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
  };
  open();

  return () => { alive = false; ws?.close(); };
}
```

`supplyTick` for one-record updates merges into the cache; if you receive a replay batch (e.g. on reconnect), `supplyData` is the right tool.

## 3. Symbol switch without flushing indicator caches

```ts
async function switchSymbol(chart: TimeSeriesChart, newSymbol: string) {
  // primary OHLC is symbol-specific — flush it
  chart.clearCache({ channelId: 'primary' });

  // sma20 / volume / events caches survive — they're conceptually attached to
  // *the same symbol* via the channel id, so if your indicator IDs are
  // symbol-scoped (e.g. 'sma20:AAPL' vs 'sma20:MSFT') you're already correct.

  // If your indicator IDs are NOT symbol-scoped, also clear them:
  chart.clearCache({ channelId: 'sma20' });
  chart.clearCache({ channelId: 'volume' });

  // Optionally update your own state so the data:request handler fetches the right symbol:
  state.symbol = newSymbol;
  // The chart will fire a fresh data:request on its next render — your handler
  // reads `state.symbol` and fetches accordingly.
}
```

The choice of channel-id naming (symbol-scoped vs not) is yours. Symbol-scoped IDs (`'sma20:AAPL'`) keep more in cache when the user toggles between symbols; un-scoped IDs save memory when you have many symbols.

## 4. Custom price-range provider (e.g. for a horizontal-line drawing)

```ts
import type { PriceRangeProvider, PriceRange } from 'carta';

class HorizontalLineProvider implements PriceRangeProvider {
  constructor(private getPrices: () => readonly number[]) {}
  priceRangeInWindow(): PriceRange | null {
    const prices = this.getPrices();
    if (prices.length === 0) return null;
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }
}

const lines: number[] = [];
const provider = new HorizontalLineProvider(() => lines);
chart.addPriceRangeProvider(provider);

// When you add/remove a line, the chart's auto-scale will include them:
lines.push(127.50);
chart.priceScale().setAutoScale(true); // re-trigger if you've manually zoomed
```

Use this for host-managed alert lines, session ranges, support/resistance overlays. Built-in drawing tools (`chart.drawings`) feed their auto-scale through this same mechanism internally — you can add your own provider alongside without conflict.

## 5. Multi-chart dashboard (linked crosshair)

```ts
async function linkedCharts(containers: HTMLElement[]) {
  const charts = await Promise.all(containers.map(c =>
    TimeSeriesChart.create({
      container: c,
      startTime: Date.now() - 200 * 60_000,
      endTime: Date.now(),
      intervalDuration: 60_000,
    })
  ));

  // Sync windows: when one pans, the others follow.
  let syncing = false;
  charts.forEach(chart => {
    chart.on('window:change', win => {
      if (syncing) return;
      syncing = true;
      try {
        for (const other of charts) {
          if (other === chart) continue;
          other.setWindow({ startTime: win.startTime, endTime: win.endTime });
        }
      } finally { syncing = false; }
    });
  });

  return charts;
}
```

`syncing` flag prevents an infinite cascade of `window:change` events. Ditto if you sync `interval:change`.

## 6. Custom legend driven by `crosshair:move`

```ts
const legendEl = document.getElementById('legend')!;

chart.on('crosshair:move', cx => {
  if (cx.time === null) {
    legendEl.textContent = '';
    return;
  }
  const parts: string[] = [`t=${new Date(cx.time).toISOString()}`];
  cx.seriesData.forEach((record, key) => {
    if (!record) return;
    if ('open' in record) {
      parts.push(`O=${record.open} H=${record.high} L=${record.low} C=${record.close}`);
    } else if ('value' in record) {
      parts.push(`v=${record.value}`);
    }
  });
  legendEl.textContent = parts.join('  |  ');
});
```

`cx.seriesData` is keyed by the `Series` instance you passed to `addSeries` — keep references to your series objects if you want to tag the legend by which series produced which value:

```ts
const candles = new CandlestickSeries({ channel: 'primary' });
const sma20   = new LineSeries({ channel: 'sma20' });
chart.addSeries(candles);
chart.addSeries(sma20);

chart.on('crosshair:move', cx => {
  const ohlc = cx.seriesData.get(candles as any);
  const sma  = cx.seriesData.get(sma20 as any);
  // ...
});
```

(`as any` because `seriesData` is keyed by the opaque `CrosshairSeriesKey` brand — the runtime value is your series instance.)

## 7. Pre-loading data before the user pans there

```ts
async function preloadFuture(chart: TimeSeriesChart) {
  const win = chart.getWindow();
  const ahead = win.endTime - win.startTime;  // pre-load one window's worth

  // Predict the next request and serve it before the user pans
  const records = await myBackend.fetchOhlc({
    channelId: 'primary',
    kind: 'ohlc',
    intervalDuration: win.intervalDuration,
    startTime: win.endTime,
    endTime: win.endTime + ahead,
  } as any);
  chart.supplyData('primary', win.intervalDuration, records);
}
```

The chart de-dupes by `(channel, interval, time)`, so it's safe to over-supply. The next pan into the pre-loaded range won't fire a new `data:request` — `missingRanges()` would already report empty.

## 8. SSR-safe Carta module (Next.js / Nuxt / SvelteKit)

Carta touches `document` and the GPU — strictly client-only. Two options:

### Next.js: `'use client'` directive

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { TimeSeriesChart, CandlestickSeries } from 'carta';

export default function Chart() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    /* ... see React example ... */
  }, []);
  return <div ref={ref} style={{ width: '100%', height: 480 }} />;
}
```

### Next.js: `dynamic` with `ssr: false`

```tsx
import dynamic from 'next/dynamic';
const Chart = dynamic(() => import('./Chart'), { ssr: false });
```

### SvelteKit: `onMount` is browser-only

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  let container: HTMLDivElement;
  onMount(async () => {
    if (!browser) return;
    const { TimeSeriesChart, CandlestickSeries } = await import('carta');
    /* ... */
  });
</script>
```

The dynamic `import()` keeps Carta out of the SSR bundle — useful when the host has a strict SSR build.

## 9. Disposing a chart after a route change

If your router doesn't unmount components (e.g. caching), call `chart.destroy()` from your route's `beforeUnmount` / `beforeLeave` / `cleanup` hook AND null out your ref. After `destroy`, all chart methods throw — never call them again.

## 10. Theme reactive to OS dark-mode

```ts
import { TimeSeriesChart, DarkTheme, LightTheme } from 'carta';

const mq = window.matchMedia('(prefers-color-scheme: dark)');
const apply = () => chart.applyOptions({ theme: mq.matches ? DarkTheme : LightTheme });
mq.addEventListener('change', apply);
apply();
```

`applyOptions` shallow-merges, so passing a full theme object replaces every key. To patch only specific colors against the active theme:

```ts
chart.applyOptions({ theme: { background: 0x0a0e14, gridAlpha: 0.4 } });
```

## 11. Manual price-scale lock for trading hours

```ts
// Lock the price scale at start-of-session — useful for "session range" displays.
const sessionLow  = 100;
const sessionHigh = 110;
chart.priceScale().setAutoScale(false);
chart.priceScale().setDomain(sessionLow, sessionHigh);

// Resume auto-scale on user interaction:
chart.on('window:change', () => {
  if (!chart.priceScale().isAutoScale()) {
    // Optional: detect a user gesture and re-enable auto-scale.
    // Without this, manual lock persists across pans.
  }
});
```

For simpler "follow auto-scale unless the user explicitly drags the price strip", do nothing — the price-axis drag handles it natively.

## 12. Clean teardown checklist

When the host page goes away:

```ts
chart.removeAllListeners();
chart.destroy();
chartRef = null;
```

If you attached a websocket or a `setInterval`, dispose those alongside. The chart's `destroy()` doesn't know about your tickers.

## 13. Programmatic tracking-mode UX

Use cases: "click to set a price alert at this bar", "tap to inspect", "freeze the crosshair while presenting".

```ts
// Pin to the latest bar's high:
const win = chart.getWindow();
const lastBar = chart.recordsInRange('primary', win.intervalDuration, win.endTime - win.intervalDuration, win.endTime).at(-1);
if (lastBar && 'high' in lastBar) {
  chart.enterTrackingMode({ time: lastBar.time, price: lastBar.high });
}

// Listen for state transitions (e.g. show a "TRACKING" badge in your UI):
chart.on('tracking:change', t => {
  badge.style.display = t.active ? 'inline' : 'none';
});

// Programmatic exit:
chart.exitTrackingMode();
```

`enterTrackingMode` is idempotent — re-entering while already active does NOT fire a second event. Same for exit.

## 14. Multi-pane layout — candle + volume + RSI + MACD

```ts
import {
  TimeSeriesChart, CandlestickSeries, HistogramSeries, LineSeries,
} from 'carta';

const chart = await TimeSeriesChart.create({
  container, startTime, endTime, intervalDuration: 60_000,
});

chart.addSeries(new CandlestickSeries({ channel: 'primary' }));     // primary pane

const volume = chart.addPane({ stretchFactor: 0.25, header: { title: 'Volume' } });
chart.addSeries(new HistogramSeries({ channel: 'volume', paneId: volume.id }));
volume.applyOptions({
  priceFormatter: v => v >= 1e6 ? `${(v/1e6).toFixed(1)}M`
                    :  v >= 1e3 ? `${(v/1e3).toFixed(1)}K`
                    : `${v}`,
});

const rsi = chart.addPane({
  stretchFactor: 0.20,
  header: { title: 'RSI 14' },
  priceScales: { right: { mode: { kind: 'bounded', min: 0, max: 100 } } },
});
chart.addSeries(new LineSeries({ channel: 'rsi14', paneId: rsi.id, color: 0xa78bfa }));

const macd = chart.addPane({
  stretchFactor: 0.20,
  header: { title: 'MACD 12/26/9' },
});
chart.addSeries(new LineSeries({ channel: 'macd-line',   paneId: macd.id, color: 0x58a6ff }));
chart.addSeries(new LineSeries({ channel: 'macd-signal', paneId: macd.id, color: 0xff9e3b }));
chart.addSeries(new HistogramSeries({ channel: 'macd-hist', paneId: macd.id }));

// Drag-resize separators are automatic. Programmatic moves:
chart.swapPanes(rsi.id, macd.id);          // RSI ↔ MACD
chart.setPaneCollapsed(macd.id, true);      // header-only
chart.setPaneHidden(volume.id, true);       // hide entirely

chart.on('pane:settings', e => openSettingsDrawer(e.paneId));   // gear button click
chart.on('pane:reorder',  e => persistPaneOrder(e.order));      // user drag-reorder
```

The `data:request` handler still routes by `channelId` — pane-routing is purely about *where* the series renders, not *which* data feeds it.

## 15. Drawing tools — full lifecycle

```ts
import {
  TimeSeriesChart, CandlestickSeries, installHotkeys,
  asTime, asPrice, asDrawingId, MAIN_PANE_ID,
} from 'carta';
import type { TrendlineDrawing, FibRetracementDrawing, DrawingsSnapshot } from 'carta';

const chart = await TimeSeriesChart.create({ container, startTime, endTime, intervalDuration: 60_000 });
chart.addSeries(new CandlestickSeries({ channel: 'primary' }));

// 1. Hotkeys: Alt+T trendline, Alt+H horizontal, Alt+R rectangle, Alt+F fib, Alt+Shift+L long, …
const disposeHotkeys = installHotkeys(chart);

// 2. Magnet snap to OHLC for clean fibs.
chart.setMagnet('weak');                                          // 'off' | 'weak' | 'strong'

// 3. Programmatic create — clicks place anchors.
chart.drawings.beginCreate('fibRetracement', {
  levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  showPrices: true,
});

// 4. Or insert a fully-formed drawing.
const trend: TrendlineDrawing = {
  id: asDrawingId(''),                                            // empty → auto-uuid
  kind: 'trendline',
  schemaVersion: 1,
  locked: false, visible: true, z: 0,
  style: { stroke: { color: 0x58a6ff, width: 2 } },
  anchors: [
    { time: asTime(t1), price: asPrice(100), paneId: MAIN_PANE_ID },
    { time: asTime(t2), price: asPrice(105), paneId: MAIN_PANE_ID },
  ],
};
chart.drawings.add(trend);

// 5. Selection / edit / context-menu.
chart.on('drawings:selected', e => {
  console.log('count:', e.drawings.length, 'primary:', e.primary?.kind);
});
chart.on('drawing:edit',        e => openMyEditor(e.drawing));
chart.on('drawing:contextmenu', e => openMyContextMenu(e.drawing, e.screen));

// 6. Hotkey: extend or pre-empt.
chart.on('keyboard:hotkey', e => {
  if (e.binding === 'arrow') {
    e.originalEvent.preventDefault();        // suppress Carta's beginCreate('arrow')
    myCustomArrowFlow();                      // your own UI
  }
});

// 7. Persist via your own storage adapter.
chart.drawings.attachStorage({
  async load(scope) {
    const raw = localStorage.getItem(`drawings:${scope.symbol}`);
    return raw ? JSON.parse(raw) as DrawingsSnapshot : null;
  },
  async save(scope, snapshot) {
    localStorage.setItem(`drawings:${scope.symbol}`, JSON.stringify(snapshot));
  },
}, { symbol: 'AAPL' });

// 8. Versioned snapshot dump/load (e.g. server-side persistence).
const snap = chart.drawings.getSnapshot();           // { schemaVersion: 1, drawings: [...] }
const result = chart.drawings.loadSnapshot(unknown);  // { droppedCount, droppedKinds }
if (result.droppedCount > 0) {
  toast(`Skipped ${result.droppedCount} drawings: ${result.droppedKinds.join(', ')}`);
}

// On unmount:
disposeHotkeys();
chart.drawings.detachStorage();
chart.destroy();
```

**Drawing on a non-primary pane.** The drawing's anchor `paneId` decides *which* pane it lives in. Once a pane is created, drag-creating via the toolbar lands in whichever pane the user clicks; programmatic insertion must carry `paneId: thatPane.id`.

## 16. Carta in a resize-observable container (CSS grid, drawer, modal)

`autoResize: true` (the default) listens to `ResizeObserver` on the container. If your container doesn't change size via CSS layout (e.g., it's transformed via `scale()` instead of `width`/`height`), Carta won't see it. Drive resize manually:

```ts
const ro = new ResizeObserver(([entry]) => {
  const { inlineSize, blockSize } = entry.contentBoxSize[0];
  chart.resize(inlineSize, blockSize);
});
ro.observe(container);
```

Also remember to disconnect the `ResizeObserver` on cleanup.
