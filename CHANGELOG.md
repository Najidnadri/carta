## [Unreleased]

### Changed

- **Tooling — replace ESLint with oxlint (type-aware).** Deletes
  `eslint.config.js`, drops `@eslint/js`, `eslint`, `globals`,
  `typescript-eslint`, `@typescript-eslint/eslint-plugin`, and
  `@typescript-eslint/parser`; adds `oxlint` and `oxlint-tsgolint`. New
  `.oxlintrc.json` ports every prior rule 1:1 — syntactic rules via the
  built-in `eslint` / `typescript` plugins, type-aware rules via tsgolint —
  with the same severities, options, and `**/*.test.ts` / `e2e/**`
  overrides. All 7 default rule categories (`correctness`, `suspicious`,
  `perf`, `pedantic`, `style`, `nursery`, `restriction`) are set to `off`
  so only the curated allow-list fires; matches the prior ESLint surface
  byte-for-byte (expanding categories is a separate, scoped decision).
  `pnpm lint` rewired to `oxlint --type-aware`; runtime drops from ~6 s to
  ~1 s on 148 files. New `e2e/tsconfig.json` shim (extends
  `../tsconfig.e2e.json`) so tsgolint — which auto-discovers the nearest
  `tsconfig.json` per file and does not honour `--tsconfig` — can resolve
  the e2e program. Fixes 3 real `prefer-optional-chain` violations the old
  ESLint pass had silently missed (`drawings/parsers.ts:527`, `:532`,
  `DrawingsController.ts:2925`) and removes 3 stale
  `// eslint-disable-next-line` comments from tests. The
  `masterplan-continue` skill's frontmatter, Step 7 ("Lint guard (oxlint
  type-aware)"), and Quick Reference are updated to match.

### Added

- **Phase 15 Cycle C — storage adapter library + image watermark + thumbnail
  capture + demo catalog.** Closes phase 15. Ships the `ChartStorageAdapter`
  interface and two reference implementations so hosts can wire saved
  layouts to whichever backend they prefer without the chart class growing
  a persistence dependency. New `ChartStorageAdapter` in
  `src/core/persistence/adapters/types.ts` exposes `listCharts()`,
  `getChart(id)` returning `{meta, state} | null`, `saveChart(input)`
  returning the full `ChartMetadata` (not a bare id — eliminates the
  list-after-save round trip), `removeChart(id)`, and `renameChart(id, name)`;
  optional template ops gate on `enableTemplates`. `ChartMetadata` carries
  `{id, name, symbol?, createdAt, modifiedAt, thumbnailUrl?, bytes}`; `ChartId`
  and `TemplateId` are nominal brands so a chart id never accidentally
  flows into a template slot. `SaveChartInput.thumbnail` is `Blob` — the
  IDB adapter stores it natively, the localStorage adapter converts to a
  data URL on the way in. Errors are typed via the new `CartaStorageError`
  with codes `'QUOTA' | 'NOT_FOUND' | 'IO' | 'UNAVAILABLE' | 'STALE_SCHEMA'`,
  and `mintId<T>()` mints RFC 4122 v4 UUIDs via `crypto.randomUUID` with a
  `crypto.getRandomValues` fallback (fail-loud `UNAVAILABLE` if neither
  exists). The `localStorageAdapter()` reference impl in
  `adapters/localStorage.ts` detects quota errors by all three cross-browser
  names (`QuotaExceededError`, legacy `QUOTA_EXCEEDED_ERR`, Firefox
  `NS_ERROR_DOM_QUOTA_REACHED`) and wraps to `CartaStorageError('QUOTA')`
  without LRU-evicting the trader's other layouts (host UX call); runs a
  construction-time probe (`setItem('__carta_probe', '1')` then
  `removeItem`) so Safari Private Browsing throws `'UNAVAILABLE'`
  synchronously instead of failing silently on first save. The Cycle C
  spec-bug fix-up: **orphan-blob rollback on index-write QUOTA**. The
  cycle's pre-test code wrote the chart blob first and the index second;
  an index-write QUOTA between them used to leak a blob no `getChart`
  path could reach. The fix snapshots the prior blob string before the
  blob write and restores it on rollback (new rows roll back to absent;
  overwrites restore byte-equal). Corrupt-index recovery (logger.warn +
  return `[]`); orphan-row self-heal in `getChart` (if the index lists
  an id whose blob is gone, remove the index row and return `null`);
  configurable `prefix` (default `'carta'`) and `storage` override (for
  tests). The `indexedDbAdapter()` reference impl in
  `adapters/indexedDb.ts` opens lazily and closes after 30 s of idle via
  a `resetIdleTimer` called on every op — releases the `versionchange`
  lock so other tabs can upgrade. Schema v1 creates a single `charts`
  store keyed by `id` with `idx_modifiedAt` (for `listCharts()` recent-
  first ordering) and `idx_symbol` (reserved for future filtering) plus
  an opt-in `templates` store under the same DB. `onversionchange`
  closes our connection and latches `staleSchema = true` so every
  subsequent op throws `CartaStorageError('STALE_SCHEMA',
  'another tab upgraded the IDB schema; reload to continue')`. The
  Cycle C spec-bug fix-up: **circular-state mapping**. `JSON.stringify`
  in the bytes calc used to throw a raw `TypeError` on circular `state`
  inputs; now wrapped in try/catch and re-thrown as
  `CartaStorageError('IO', 'indexedDB save: state is not
  JSON-serializable')`. Promise plumbing lives in
  `adapters/idbPromise.ts`: `reqAsPromise(req)` and `txAsPromise(tx)`
  with `addEventListener` semantics (no `req.onsuccess = ...` reassignment
  races). The wrappers document the "no `await` between two ops in the
  same transaction" Safari constraint; all adapter call sites fire
  requests synchronously inside one tx and await the `complete` event
  rather than `success`. **Image watermark via PixiJS v8 `Assets.load`**.
  New `ImageWatermarkLayer` (`src/core/persistence/ImageWatermarkLayer.ts`)
  is a `Container` subclass with `async load(url, w, h, opts)` that
  resolves to a Texture via `Assets.load(url)` then mounts a sized
  `Sprite` inside the layer; a generation counter (`++this.generation`)
  cancels superseded loads — if a second `load()` arrives before the
  first's `Assets.load` resolves, the superseded generation runs
  `Assets.unload(url)` to balance the cache refcount and returns without
  adding a sprite. Default sizing fits the intrinsic image inside a 25 %-
  of-canvas box preserving aspect ratio, with `scale`/`maxWidth`/`maxHeight`
  knobs and 5-position anchoring (`top-left`/`top-right`/`bottom-left`/
  `bottom-right`/`center`). `destroy()` calls `Assets.unload(url)` fire-
  and-forget so a chart destroyed mid-load doesn't leak the texture.
  `WatermarkConfig.image` widens from the cycle-A reserved `string` slot
  to `{url, scale?, maxWidth?, maxHeight?}`; `pngExport.ts` gains a
  `buildWatermark(config, w, h, themeText)` helper that picks the image
  branch when supplied (image wins over text — traders who paste a logo
  URL mean it as the primary mark) and mounts the layer between
  `computeLayoutAndPaint` and `renderer.render({target:rt})`, unmounted +
  `layer.destroy()` in `finally` (`mountWatermarkChild` is the new friend
  callback on `ExportContext`, exposing `stage.addChild`/`removeChild`
  without leaking the Pixi container surface). New `ExportError` code
  `'WATERMARK_FAILED'` is thrown on `Assets.load` rejection (404, DNS
  fail, decode failure) with a host-friendly wrapped message
  (`watermark image failed to load from "<url>" — check the URL is
  reachable and serves CORS headers if cross-origin (raw: ...)`); a
  CORS-tainted `SecurityError` at `extract.canvas` time is mapped from
  `GENERIC` to `WATERMARK_FAILED` only when a watermark layer was mounted
  for this export. **Thumbnail capture flow** stays decoupled — the demo
  (and any host) calls `chart.exportPNG({width:240, height:120, scale:1,
  format:'image/webp', quality:0.7})` then hands the Blob to
  `adapter.saveChart({…, thumbnail: blob})`. The explicit `scale: 1` is
  important: cycle A's default `scale: 2` retina-grade behaviour produces
  a 480×240 bitmap for a 240×120 CSS request, which is the right call for
  full screenshots but quadruples thumbnail bytes; the demo opts in to
  pixel-exact 240×120. **Demo catalog UI** lives in a new
  `<fieldset id="catalog-fieldset">` next to the cycle-A `#persistence-
  toolbar` with `[data-testid="catalog-select / catalog-save-new /
  catalog-overwrite / catalog-load / catalog-rename / catalog-delete /
  catalog-thumb"]`. `<option>` text formats as `"<name> · <relative-time>
  · <KB> KB"` with recent-first ordering driven by `idx_modifiedAt`. The
  selected entry's thumbnail flips a `<img>` between `display:none` and
  `display:inline-block` with `URL.createObjectURL` minted on selection
  change and `URL.revokeObjectURL` on the next transition to keep memory
  steady across long sessions. Save-as-new uses `window.prompt`,
  overwrite uses the active `<select>.value`, delete uses
  `window.confirm`. Demo wires `indexedDbAdapter({dbName:'carta-demo-
  catalog'})` by default. **Mobile-toolbar overflow fix** closes cycle B's
  carry-over: both `#persistence-toolbar` AND `#catalog-fieldset` got
  `flex-wrap:wrap` + `row-gap:6px`, so the fieldsets themselves wrap to
  multiple rows at 375 px instead of horizontally scrolling. **5 new
  package exports + 12 supporting types**: `localStorageAdapter` +
  `LocalStorageAdapterOptions`, `indexedDbAdapter` +
  `IndexedDbAdapterOptions`, `ImageWatermarkLayer` +
  `ImageWatermarkOptions` + `ImageWatermarkPosition`,
  `ChartStorageAdapter` / `ChartMetadata` / `ChartTemplateMetadata` /
  `ChartId` / `TemplateId` / `SaveChartInput` / `SaveTemplateInput` /
  `CartaStorageError` / `CartaStorageErrorCode` / `isQuotaError` /
  `mintId` / `reqAsPromise` / `txAsPromise`. **56 new vitest cases**
  (1059→1115/1116 passing): 21 in `adapters/localStorage.test.ts`
  (CRUD, ordering, quota mapping, **orphan-blob rollback both new-row
  and overwrite paths**, corrupt-index recovery, orphan self-heal, custom
  prefix, templates round-trip, FileReader unavailable, Safari Private
  probe); 16 in `adapters/indexedDb.test.ts` (CRUD, recent-first
  ordering, rename/remove NOT_FOUND, overwrite preserves createdAt +
  symbol, Blob thumbnail round-trip, opt-in templates,
  idle-close + reopen, **circular-state → IO mapping**, parallel saves
  mint distinct ids); 6 in `adapters/idbPromise.test.ts` (request
  resolve/reject/null-error, tx complete/error/abort); 9 in
  `ImageWatermarkLayer.test.ts` (load success + sprite add, fit-inside
  default + maxWidth + scale, 5-position math, load rejection + no
  sprite, generation-counter supersede, `Assets.unload` on destroy).
  **test-carta first pass**: 25 PASS / 4 FAIL / 4 manual-review / 3
  INDETERMINATE out of 36 UX ACs, `PARENT_NEXT_STEP=continue` with 0
  blocking failures. **2 fix-ups landed inline post-test**: AC-C-24
  thumbnail dims (added `scale:1` to demo's `captureThumbnail`); AC-C-19
  message quality (host-friendly `WATERMARK_FAILED` message in
  `buildWatermark`). **2 demo-shell carry-overs** documented in trackers:
  AC-C-01/02 mobile `<header>` overflow (pre-cycle-C sibling controls
  force 1664 px at 375 px viewport — library is correct, demo header
  needs collapsible disclosure); AC-C-34 demo `#persistence-status`
  hidden in collapsed `#persistence-panel` `<aside>` by default.
  Performance: `listCharts(100)` p95 = 3 ms (budget 150), `exportPNG`
  thumbnail p95 = 433 ms on SwiftShader (budget 800), 50× rapid
  `saveChart` total = 118 ms (budget 3000), heap delta 50× listCharts =
  0.76 MB (budget 5). **Real-GPU perf re-bench** remains the same
  WSL2/SwiftShader carry-over as phases 13 + 14. New dev-dependency
  `fake-indexeddb` for in-process IDB testing. See miniplan
  `plans/15-save-load-export.md` §6 Cycle C, research
  `.research/phase-15-cycleC-test-matrix.md`, test report
  `test-reports/phase-15-cycleC-2026-05-16.md`.

- **Phase 15 Cycle B — CSV export + URL permalink.** Ships the
  shareable-screenshot half of the persistence subsystem.
  `chart.exportCSV(opts?: CsvExportOptions): string` is a pure encoder
  in `src/core/persistence/csv.ts`. UTF-8 BOM (default), CRLF line
  endings (default), comma delimiter / period decimal (default with
  DACH-style `decimal:',', delimiter:';'` opt-in), per-series precision
  in `[0, 12]` (default 2), `'iso'` (default) / `'epoch-ms'` time
  formats; channel kind decides row shape (`ohlc` → `time, open, high,
  low, close, volume?`; `point` → `time, value`; marker channels throw
  synchronously). Fail-loud on unknown channel / marker channel /
  `delimiter === decimal` / out-of-range precision via
  `ExportError('GENERIC', …)`. Emits `'export:partial-data'` once per
  call when the requested range straddles cache gaps (computed via the
  existing `DataStore.missingRanges`); phantom rows are NOT synthesized
  — a half-empty CSV is more honest than a fabricated one. Friend
  interface `CsvExportContext` mirrors the cycle-A `SaveContext` pattern.
  `chart.permalink(opts?: PermalinkOptions): string` ships two tiers
  with `tier: 'minimal' | 'full' | 'auto'` (default `'auto'`). Tier 1
  encodes a compact `URLSearchParams` shape
  `#c=1&pc=<channel>&i=<ms>&f=<startMs>&t=<endMs>&y=<seriesKind>&th=<theme>[&s=<symbol>]`
  capped at 200 chars; throws `PermalinkTooLargeError(actual, limit)`
  past the cap. Tier 2 uses `lz-string@^1.5.0` (regular dep, ~3.8 KB
  minified, tree-shaken when `permalink()` is never called) via the
  typed `lzCodec.ts` wrapper, encoding as `#z=` +
  `compressToEncodedURIComponent(JSON.stringify(chart.save()))` capped
  at 8192 chars by default. The `'auto'` tier picker promotes to
  `'full'` when drawings exist OR ≥ 2 series OR the theme is non-preset
  OR theme overrides exist OR there are extra panes beyond `MAIN_PANE_ID`
  — the trader who hits Share with 30 drawings gets a Tier 2 link
  instead of silently losing them. `TimeSeriesChart.fromPermalink(fragment):
  Partial<ChartSaveState>` is the static decoder; accepts bare `#frag`,
  `?query`, `URL#frag`, and bare `key=value` envelopes (hash wins over
  query per RFC 3986). Tier 1 decode validates `c === '1'`, finite
  `f`/`t`, positive-integer `i`, `y ∈ SERIES_KINDS`, `th ∈ {light, dark,
  custom}`. Tier 2 runs the cycle-A `migrate → isChartSaveState` pipeline
  unchanged so a single round-trip codepath stays tested. Zero `as`
  casts on the public boundary; throws `CartaSchemaError` on any
  malformed input. The typed `lzCodec.ts` wrapper boxes `lz-string`'s
  `decompressFromEncodedURIComponent` so the runtime `null`-on-malformed
  return doesn't slip through the d.ts-narrowed `string` type — guarded
  by `typeof raw !== 'string'` so a mangled Tier 2 body throws
  `CartaSchemaError` instead of leaking a raw `TypeError`. Demo grows
  `[data-testid="export-csv" / "permalink" / "permalink-load"]` buttons
  in the cycle-A `#persistence-toolbar`; permalink button writes the
  fragment to the clipboard via `navigator.clipboard.writeText` (silent
  on failure — textarea fallback). Permalink Load routes Tier 2 results
  through `chart.load(state)` and Tier 1 results through `setWindow` +
  `setInterval`. **UX-3 carry-over from cycle A closed**: Esc closes the
  persistence panel from any focus state, and click-outside-closes
  whitelists the toolbar fieldset so clicking another toolbar button
  re-opens the panel without thrashing. **55 new vitest cases** (943→998
  passing then 998→1059 after one P0 fix-up — `lzCodec.lzDecode` did not
  guard the runtime-`null` return from `lz-string`'s
  `decompressFromEncodedURIComponent`; the d.ts narrowed it to `string`
  but the runtime returns `null` for malformed input). 25 CSV cases
  (BOM/CRLF/LF/precision/locale/NaN/Infinity/missing-volume/empty-range/
  single-bar/marker-throw/unknown-channel-throw/100K-perf canary); 30
  permalink cases (Tier 1 round-trip + URI-escape on `BRK.B` / `7203.T` +
  200-char soft cap; Tier 2 round-trip + 8192 hard cap + URI-safe
  alphabet + JSON-parse + post-migrate validation; envelope edge cases
  for `#`, `?`, full-URL, bare, empty; auto-tier picks for drawings /
  multi-series / custom theme / extra panes; **regression** for the
  mangled-lz-body fix). Performance budgets crushed: CSV 100K rows p95 =
  264.7 ms (budget 1000 ms), Tier 1 encode mean ≈ 12 µs (budget 1 ms),
  Tier 2 encode 30 KB JSON < 200 ms, permalink decode mean < 50 ms, 100×
  rapid permalink heap delta 0.75 MB. New regular dependency
  `lz-string@^1.5.0`. See miniplan `plans/15-save-load-export.md` §6
  Cycle B, test report
  `test-reports/phase-15-cycleB-2026-05-16.md` (includes re-run #1
  section after the `lzCodec` null-guard fix-up landed inline).

- **Phase 15 Cycle A — declarative save / load + PNG export.** Ships the
  trader-grade screenshot + layout-persistence pipeline. New
  `chart.save(): ChartSaveState` is synchronous and JSON-stringifiable:
  `schemaVersion: 1` with window, intervalDuration, sparse theme overrides
  via the new `themeExplicitKeys` Set (the chart now records every key
  passed to `applyOptions({theme})` so save emits only the host's
  customizations, not the full preset), a discriminated 8-kind
  `SeriesSaveEntry` union with `paneId`/`priceScaleId`/`scaleMargins`
  baked into each series's options blob, pane heights /
  collapsed / header / per-slot `PriceScaleMode`, drawings snapshot,
  optional `primarySymbol` via host-supplied
  `applyOptions({persistence:{getSymbol}})` callback, and
  `ui.trackingMode`. `chart.load(state, opts?): Promise<void>` validates
  the input through a zero-`as` type guard (`isChartSaveState` rejects
  non-integer / negative / future `schemaVersion`, NaN windows,
  non-positive intervals, unknown chart types, duplicate pane IDs as a
  cross-field check, and non-positive `stretchFactor`/`minHeight` /
  negative `heightOverride`), migrates through a chained-migrator scaffold
  (`CartaSchemaError` on `>1` / unregistered step), cancels in-flight
  pointer/drag/brush, then applies theme → interval (cache reset) →
  window → panes (remove orphans → add missing → applyOptions →
  `reorderPanes` final pass to restore saved order via the existing
  `applyReorder` transaction) → drawings → series (drop-all + re-create
  via the matching concrete constructor). The chart polls
  `hasPendingDataRequest()` for a 50 ms quiet window or the host's
  `fetchTimeoutMs` (default 5 s) before emitting `state:loaded` or
  `state:partial-loaded{reason:'timeout'}`. `AbortController` plumbed
  through `chart.destroy()` → in-flight load rejects with
  `OperationCanceledError`. Newer-wins on concurrent loads. New
  `chart.exportPNG(opts?): Promise<Blob>` renders off-screen via PixiJS
  v8 `RenderTexture` + `app.renderer.extract.canvas` + `canvas.toBlob`
  (also handles `OffscreenCanvas.convertToBlob`); defers up to
  `deferTimeoutMs` (default 2 s) waiting for the new `'idle'` event after
  `isGestureActive() === false`, rejects with `ExportError('EBUSY')` on
  timeout. Pre-flight clamps the requested texels to
  `MAX_TEXTURE_SIZE` (WebGL `gl.MAX_TEXTURE_SIZE` with `16384` WebGPU
  fallback) and emits `export:size-clamped {requested, clamped, max}`.
  Hides `crosshairLinesLayer` / `crosshairTagsLayer` /
  `drawingsHandlesLayer` and calls the new
  `DrawingsController.suspendTransients()` /
  `resumeTransients(token)` so the rendered PNG carries no selection
  halo / ghost preview / marquee / hover affordance. Default `scale: 2`
  for retina; format `image/png` / `image/webp` / `image/jpeg`. Visible
  canvas is **never** resized: `ConfigState.withSize` is transiently
  mutated then restored, `renderer.resolution = 1` for the export pass
  then restored, `reflushOriginal` repaints the stage at the original
  dims before the export promise resolves (pixel-digest unchanged
  pre/post verified). Destroy-mid-export rejects cleanly with
  `ExportError('CANCELLED')` — pngExport.ts now checks `isDisposed` at
  every Pixi boundary (before render / before extract / before+after
  `toBlob`) and wraps every `finally` cleanup op in `try/catch` so a
  destroyed renderer's null GL state never escapes as a raw `TypeError`.
  New text-only `WatermarkLayer` (image variant deferred to cycle C).
  `flush()` split into `computeLayoutAndPaint(reasons, present)` so the
  export reuses the layout pipeline against the `RenderTexture` without
  presenting to the live canvas. `maybeEmitIdle()` emits the new `'idle'`
  event on the first clean frame after `isGestureActive()` transitions
  false (idempotent / once-only safe — narrower than the originally
  proposed `'flushed'` event). New public `chart.isGestureActive()`
  ORs viewport active-pointer / kinetic / pane-resize-drag /
  pane-header-drag / price-axis-drag (new `isDragging()` public flag) /
  drawings interaction (new `isInteracting()` public flag). New abstract
  `Series.getOptions(): Readonly<object>` with 1-line `{...this.opts}`
  delegates on all 8 concrete series (Candlestick / OhlcBar / HeikinAshi
  / Line / Area / Histogram / Baseline / MarkerOverlay). New
  `CartaEventMap` entries: `idle`, `state:loaded`,
  `state:partial-loaded`, `export:ready`, `export:deferred`,
  `export:failed`, `export:size-clamped`. `TimeSeriesChartOptions` +
  `ApplyOptions` gain a `persistence?: PersistenceOptions` field. Demo
  ships three new buttons in a `#persistence-toolbar` fieldset (Save
  layout / Load layout / Screenshot) plus a floating `#persistence-panel`
  with a JSON textarea (`[data-testid="persistence-textarea"]`), inline
  PNG preview (`[data-testid="screenshot-preview"]`, object-URL with
  `URL.revokeObjectURL` on repeat), and a counts-and-bytes status line.
  52 new vitest cases (998/999 passing, vs 946/947 pre-cycle-A); 36
  validator negative-matrix cases (including cross-field duplicate-pane-id
  and negative-height regressions); 14 migration scaffold cases. Cycle A
  was test-carta-validated end-to-end across mobile 390×844 / tablet
  820×1180 / laptop 1440×900: 75 PASS / 9 FAIL / 4 manual-review / 3
  INDETERMINATE on the WSL2/SwiftShader software-GL host. Three P0 fixes
  landed inline (pane order restoration on load, validator negative-height
  + duplicate-pane-id cross-field, pngExport per-boundary `isDisposed`
  + finally-swallow), re-run #1 returned all four P0s PASS with zero
  regressions across smoke-tested ACs. Carry-overs to cycle B/C: Esc
  closes panel (P2 demo polish), `LOAD-007` cross-symbol load
  INDETERMINATE pending demo wiring of `persistence.getSymbol`,
  software-GL perf canaries pending real-GPU re-bench. CSV export
  (`exportCSV`), URL permalinks (`permalink` / `fromPermalink`), and the
  storage-adapter library + image watermark loader stay deferred to
  cycles B + C respectively. See
  [plans/15-save-load-export.md](plans/15-save-load-export.md) and
  research docs `feature-save-load-export.md`,
  `phase-15-cycleA-implementation.md`,
  `phase-15-cycleA-test-matrix.md`.

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
