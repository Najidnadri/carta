## [Unreleased]

### Added

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

### Changed

- **BREAKING:** `Chart` → `TimeSeriesChart`. Static factory is async:
  `TimeSeriesChart.create(options)`.
- **BREAKING:** `Candle` → `OhlcRecord`; `LinePoint` → `PointRecord`.
- **BREAKING:** `ChartOptions` → `TimeSeriesChartOptions`; new required fields
  `startTime`, `endTime`, `intervalDuration`.
- Renderer owns the 7-layer stack; only `seriesLayer` is a render group.
- PixiJS `Application` now initialized with `autoStart: false, sharedTicker: false` —
  the chart renders strictly on demand via the invalidator.

### Fixed

### Removed

- `Chart` class and old single-tick-loop renderer.
- `CandlestickSeries`, `LineSeries`, `PriceAxis`, `TimeAxis`, `LinearScale`, `TimeScale` —
  pre-1.0 scaffolding; will be re-introduced in their respective phases (02 / 04 / 07).
- Legacy `Candle`, `LinePoint`, `Range`, `Viewport`, `ChartOptions` types — replaced by
  master-plan §3.0 record types.
