## [Unreleased]

### Added

- **Phase 12 — testing infrastructure (single cycle).** Closes the v0.1
  shipping gate. Adds Playwright e2e (`playwright.config.ts`, chromium-only
  with `--use-gl=swiftshader --enable-unsafe-swiftshader`, `retries:2` in CI,
  `reuseExistingServer` locally) plus 8 specs under `e2e/` driving
  `globalThis.__cartaTest` + DOM readouts only — never canvas pixels. Specs:
  `smoke.spec.ts` (page-load + adversarial 1.4 `clearRequestLog` race),
  `pan.spec.ts`, `zoom.spec.ts` (+ adversarial 1.9 `synthWheel` deltaY=0
  no-op), `interval.spec.ts` (+ adversarial 1.6 `selectInterval(current)`
  no-op), `theme.spec.ts`. Typed harness fixture at `e2e/fixtures/chart.ts`.
- **Phase 12 — vitest v8 coverage.** `vite.config.ts` test block gains a
  `coverage` section using `@vitest/coverage-v8`. Per-glob `perFile` thresholds
  at 80 lines / 75 branches on `data/`, `price/`, `viewport/`, `infra/`,
  `time/`. Pixi-touching files (render, series, overlays, axes,
  `ViewportController`, `TimeSeriesChart`, `Chart`, `PixiRenderer`) explicitly
  excluded so coverage tracks pure-logic only. Achieved 95.22 % lines /
  90.81 % branches overall (every glob ≥ 93 % lines).
- **Phase 12 — GitHub Actions CI.** `.github/workflows/ci.yml` runs a
  `verify` job (lint → typecheck → unit + coverage → build) on `ubuntu-latest`
  with pnpm cache, then a dependent `e2e` job that caches
  `~/.cache/ms-playwright` keyed on the resolved Playwright version. Required
  from day 1 (no `continue-on-error`). Concurrency cancels in-progress runs
  on the same ref. Coverage is uploaded as an artifact on every run; the
  Playwright HTML report uploads only on failure.
- **Phase 12 — scripts.** `pnpm test:coverage`, `pnpm test:e2e`,
  `pnpm test:e2e:headed`, `pnpm test:all`. `pnpm typecheck` now also runs
  `tsc -p tsconfig.e2e.json` so the e2e tree stays type-clean. ESLint config
  gains an `e2e/**` override (relaxed `unsafe-*` rules; e2e cannot escape the
  full strict-typed-checked baseline).

### Changed

- `vitest` bumped to 4.1.5 (peer-aligned with `@vitest/coverage-v8` 4.1.5).
  No behavioral change.

**Phase 12 validation:** `pnpm test` 549/549 in 1.74 s execution time
(AC #1 read as execution time per `plans/12-testing.md` §8); `pnpm test:e2e`
8/8 in 20.2 s; `pnpm test:coverage` 95.22 % lines / 90.81 % branches
overall, every per-glob threshold passes; `pnpm build` ESM 117.74 kB / CJS
95.22 kB; `test-carta` returns 11/11 regression-sentinel stories at parity
with phase 11 cycle B (frame-time P50 ~218 ms / P95 ~275 ms on swiftshader,
matching phase 11's ~250/284). Report at
`test-reports/phase-12-testing-2026-04-25.md`. Screenshots under
`screenshots/phase-12-testing/{laptop,mobile,tablet}/`.

- **Phase 11 cycle A — demo upgrades.** New `demo/mock-source.ts` exports a
  deterministic `MockSource` class with one fetcher per channel kind
  (`fetchOhlc / fetchVolume / fetchSma / fetchEvents`) plus tick generators
  (`tickOhlc / tickVolume`). The fundamental series is at 1 m resolution;
  coarser intervals are aggregated as `open=first.open, high=max, low=min,
  close=last.close, volume=sum`. SMA fetch is self-sufficient (no
  chart-cache dependency). `tickOhlc` falls back to `basePrice` when the
  supplied `prev` is malformed (NaN/Infinity OHLC fields).
- **Phase 11 cycle A — interval / overlay / live-tick demo UI.**
  `demo/index.html` adds an interval `<select>` (1 m / 5 m / 1 h / 1 D),
  an overlay-shape `<select>` (Line / Area / Baseline against the same
  `demo-sma` channel), a `Live tick` toggle button, and a per-channel
  data-request log table (`#request-log-table`, capacity 50). Mobile
  `@media (max-width: 700px)` block makes `body` scrollable, gives `#chart`
  `min-height: 50svh`, flows the sidebar (with the new request log) below
  the chart, and bumps native `<select>` controls to ≥44×44 tap targets.
- **Phase 11 cycle A — `RequestLog` ring buffer.** `demo/request-log.ts`
  exposes a bounded append-and-drop log (capacity 50 by default) with
  per-row source tagging (`data:request` vs `cache-hit-synthetic`).
  Synthetic cache-hit rows are pushed on overlay-shape swaps when the
  SMA channel has cached records, making the no-refetch invariant visible
  to traders.
- **Phase 11 cycle A — `LiveTickDriver`.** `demo/live-tick-driver.ts`
  runs a drift-free 1 Hz `setTimeout` loop that reads the latest cached
  OHLC, calls `MockSource.tickOhlc(iv, now, prev)` to extend or
  boundary-append, and supplies paired ohlc + volume ticks via
  `chart.supplyTick`. Survives `Remount chart` — the demo replays the
  toggle state against the freshly-mounted chart.
- **Phase 11 cycle A — Playwright test hooks.** `__cartaTest`
  surface gains `MockSource`, `requestLogEntries() / requestLogTotal() /
  clearRequestLog()`, `setOverlayShape() / getOverlayShape()`,
  `startLiveTick() / stopLiveTick() / isLiveTickRunning() /
  liveTickCount() / fireLiveTickOnce()`, and `selectInterval()`. Every
  pre-existing hook (e.g. `generateOhlc`, `computePivotMarkers`,
  `loadDemoData`, `setSmaStyle`) remains callable.
- **Phase 11 cycle A — vitest coverage.** `demo/mock-source.test.ts`,
  `demo/request-log.test.ts`, `demo/live-tick-driver.test.ts` cover
  determinism, 1 m → ND aggregation, extend-vs-append boundary, NaN-prev
  fallback, ring-buffer drop semantics, drift-free scheduling, and stop
  cancellation. `vite.config.ts` `test.include` extended to
  `demo/**/*.test.ts`.
- `TimeSeriesChart` class with layered PixiJS v8 scene graph (`bgLayer / gridLayer /
  plotClip(seriesLayer, overlays, drawings) / crosshairLayer / axesLayer / legendLayer /
  tooltipLayer`), scissor-rect plot clip, and render-on-demand dirty-flag invalidation.
- `ConfigState` immutable snapshots with `withWindow` / `withInterval` / `withSize` /
  `withTheme` identity-preserving mutators.
- `InvalidationQueue` with RAF coalescing and re-entrancy-safe flush.
- Record types aligned with master plan §3.0: `OhlcRecord`, `PointRecord`, `MarkerRecord`,
  `Channel`.
- Branded units `Time` / `Interval` / `Pixel` / `Price` with `asTime` / `asInterval` /
  `asPixel` / `asPrice` mint helpers.
- Injectable `Logger` option on `TimeSeriesChart.create`; default is a no-op logger.
- `theme.frame` color for the placeholder plot frame.
- Unit tests for `ConfigState` and `InvalidationQueue`.
- `explicit-module-boundary-types` ESLint rule.
- **Phase 10 — theming & styling.** Two named theme presets are exported:
  `DarkTheme` (the default, replaces the prior `DEFAULT_THEME`) and
  `LightTheme` (TradingView-style desaturated palette on a white surface,
  GitHub-Primer text colours, `gridAlpha: 0.6`). Both ship from
  `src/core/themes.ts`.
- **Phase 10 — `Theme` typography & grid slots.** New flat fields:
  `fontFamily` (CSS font stack used by axis labels, crosshair tags, and
  marker labels), `fontSize` (uniform CSS-px size for the same), and
  `gridAlpha` (multiplier on the grid stroke alpha). All three propagate
  through `TimeAxis` / `PriceAxis` / `CrosshairController` / `MarkerOverlay`
  on every theme swap.
- **Phase 10 — `series.applyOptions(patch)`.** Every concrete series
  (`CandlestickSeries`, `OhlcBarSeries`, `HeikinAshiSeries`, `LineSeries`,
  `AreaSeries`, `HistogramSeries`, `BaselineSeries`) and `MarkerOverlay`
  exposes a public `applyOptions` accepting `Partial<TSeriesOptions>`. The
  patch is shallow-merged into the series' captured options and a single
  `'data'` invalidation is fired so the next flush re-renders with the
  new style. The series `channel` (and `MarkerOverlay`'s
  `priceReference.channel`) is pinned — passing a different channel in the
  patch is silently dropped to avoid breaking the data-store binding.
- **Phase 10 — demo "Toggle theme" button.** `demo/index.html` +
  `demo/main.ts` now flip between `DarkTheme` and `LightTheme` and persist
  the choice across `Remount chart`. CSS variables under
  `body[data-theme="dark|light"]` track the active theme. Demo header
  buttons enforce `min-height: 44px` for a ≥44×44 mobile tap target.

### Changed

- **BREAKING:** `Chart` → `TimeSeriesChart`. Static factory is async:
  `TimeSeriesChart.create(options)`.
- **BREAKING:** `Candle` → `OhlcRecord`; `LinePoint` → `PointRecord`.
- **BREAKING:** `ChartOptions` → `TimeSeriesChartOptions`; new required fields
  `startTime`, `endTime`, `intervalDuration`.
- Renderer owns the 7-layer stack; only `seriesLayer` is a render group.
- PixiJS `Application` now initialized with `autoStart: false, sharedTicker: false` —
  the chart renders strictly on demand via the invalidator.
- **BREAKING (Phase 10):** `DEFAULT_THEME` removed from the public surface; use
  the named `DarkTheme` export instead. The two are value-equivalent; the
  rename clarifies that callers can also import `LightTheme`.
- **Phase 10:** `Theme` interface gained three required fields —
  `fontFamily: string`, `fontSize: number`, `gridAlpha: number`. Hosts that
  construct a `Theme` literal must add the three slots. Hosts using
  `applyOptions({ theme: { ... } })` are unaffected because the merge stays
  shallow and any field omitted from the partial inherits from the active
  theme.
- **Phase 10:** `SeriesQueryContext` gained an optional `invalidate?: () => void`
  field. `TimeSeriesChart.addSeries` wires it automatically; standalone test
  setups can omit it and the series stays inert (`applyOptions` is a no-op
  on the invalidator).

### Fixed

- **Phase 10:** crosshair tag background and lines did not re-paint on a
  theme-only flush (the `CrosshairController.redraw` branch in
  `TimeSeriesChart.flush` had been gated to `'crosshair' | 'viewport' |
  'data' | 'layout' | 'size'` and missed `'theme'`). With the gate
  fixed and `CrosshairController.updateTag` now tracking
  `lastBgColor` to refill the rounded-rect bg when the theme colour
  changes, a theme swap with the crosshair visible repaints lines + tags
  on the next flush — no pointer move required.

### Deferred

- **Phase 10 — Inter BitmapFont atlas (10.4).** The miniplan's optional
  bundled-atlas path is intentionally not shipped. Carta uses Pixi's
  lazy glyph generation against the host's system fonts; hosts who want
  Inter (or any other family) can call `BitmapFont.install({ ... })`
  before constructing the chart and set `theme.fontFamily` to match. The
  trade-off (~80–120 KB bundle cost vs. marginal quality gain) didn't
  cash for v1 — see `.research/phase-10-theming.md` §5.
- **Per-series style override after construction (other than via
  `applyOptions`).** There is no `series.applyOptions({ priceReference:
  { channel } })` that rebinds the data channel. Channel rebinding still
  requires `removeSeries` + `addSeries`. The cycle-A `applyOptions`
  surface deliberately pins `channel` to keep the data-store binding
  honest.
- **Phase 10 — F-3 (Light-theme crosshair anti-aliasing artifact).** The
  Pixi `Graphics.stroke({ width: 1, pixelLine: true })` at sub-pixel x
  coordinates anti-aliases against the white background, blending the
  spec colour with `#FFFFFF`. The crosshair line therefore samples
  lighter than the spec value on Light theme. Latent since the
  crosshair shipped in Phase 08; not a Phase-10 regression. If it
  becomes user-visible, the fix is to snap the snapped-x to integer
  pixels before drawing.

### Removed

- `Chart` class and old single-tick-loop renderer.
- `CandlestickSeries`, `LineSeries`, `PriceAxis`, `TimeAxis`, `LinearScale`, `TimeScale` —
  pre-1.0 scaffolding; will be re-introduced in their respective phases (02 / 04 / 07).
- Legacy `Candle`, `LinePoint`, `Range`, `Viewport`, `ChartOptions` types — replaced by
  master-plan §3.0 record types.
- **Phase 10:** `DEFAULT_THEME` constant — see `DarkTheme` under "Changed".
