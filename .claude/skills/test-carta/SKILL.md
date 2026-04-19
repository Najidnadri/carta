---
name: test-carta
description: Orchestrate end-to-end feature or full-library validation of the Carta charting library. Spawns the chart-ux-expert subagent to generate trader-grade user stories and UX acceptance criteria, then spawns the playwright-test-engineer subagent to turn them into an executable Playwright plan, drive it across mobile / tablet / laptop viewports with hardware-calibrated performance benchmarks, and write a structured report. Use this skill whenever the user says anything like "test this feature", "test the chart", "run a full test pass", "validate the library", "qa this", "benchmark the chart", "check if the chart is ready to ship", or any phrasing that implies end-to-end browser-level validation of Carta. If invoked inside another workflow (e.g., by masterplan-continue), the final report path and a terse summary are returned to the parent agent so it can act on the findings.
---

# Carta end-to-end test orchestrator

This skill runs one full round of browser-level validation for the Carta charting library: decide scope, generate trader-grade user stories, translate them into a concrete Playwright plan, drive the plan through the Playwright MCP tools across mobile / tablet / laptop viewports, benchmark performance against the current machine's hardware class, and produce a single report the caller (user or parent agent) can act on.

## Why this exists

Carta is a pre-1.0 PixiJS charting library. Unit tests and the `chart-test-designer` matrix cover *data* adversarial cases. They don't cover **trader UX** — does the crosshair feel right, does the pinch-zoom preserve the right edge, does the price-axis stop flickering mid-pan, is frame time on 100k bars acceptable for *this* hardware class. This skill is the loop that answers those questions, without the user having to manually spawn two subagents and glue their outputs together.

## When to use this skill

Use it when the user wants **browser-level** validation, not code review. Trigger phrases include:

- "test this feature"
- "test the chart" / "test the library" / "full test pass"
- "validate that the chart works on mobile"
- "run the whole suite"
- "benchmark the chart"
- "qa this before I ship"
- "how does this hold up under real usage?"

Also trigger when invoked by another skill (most commonly `masterplan-continue`) in place of its own ad-hoc Playwright step. When invoked by a parent workflow, detect that (see step 0) and adjust outputs accordingly.

## When NOT to use this skill

- The user is asking a one-off question about the chart API.
- The user wants a single bug reproduction — just reproduce it directly.
- The user wants unit-test-level changes (vitest). Those are the developer's direct concern, not this skill.

## The loop

### Step 0 — Figure out scope and context

Before spawning anything, decide four things and state them back to the user in a single short message (no need to ask for permission to start; the trigger phrase is consent).

1. **Mode** — `feature` (one feature), `full` (whole library regression), or `benchmark` (performance only, skip UX correctness stories).
2. **Feature under test** — if `feature`, name it explicitly (e.g., "time axis tick placement" or "pinch zoom on mobile"). Pull this from the user's prompt or, if invoked by a parent workflow, from the parent's context (the phase being implemented).
3. **Viewports** — default is `mobile, tablet, laptop`. `full` mode additionally adds landscape-mobile, ultra-wide, and very-short. The user or parent may override.
4. **Height sweep** — the chart is expected to be embedded inside containers of varying height (dashboard tiles, collapsible drawers, modals, sidebars). Always test at multiple heights, not just the viewport default. Default height sweep per viewport:
   - **Tiny** — 180 px (a compressed dashboard tile).
   - **Small** — 300 px.
   - **Medium** — 480 px.
   - **Large** — 720 px or the full viewport height, whichever is smaller.
   At every height, the chart must still be usable: axes readable, crosshair functional, no label overlap (see the `chart-ux-expert` non-negotiable principles), no price axis collapse, no plot area squeezed to zero. If the chart receives a container height below a minimum it can honestly support, it must degrade clearly (e.g., hide the volume pane, or render a "too small" placeholder) rather than produce garbage. Include height sweeps in the briefing to both subagents.
4. **Parent context** — if you were invoked inside another workflow (e.g., `masterplan-continue` step 9), note:
   - the parent's phase name,
   - the parent's acceptance criteria,
   - the report sink path the parent wants (default `test-reports/<phase>-<ISO-date>.md`).

**Output to the user / parent (one short message):** something like

> Running `test-carta` in `feature` mode for "time axis tick placement". Viewports: mobile, tablet, laptop. Report will be written to `test-reports/phase-02-time-axis-2026-04-19.md`.

If the user contradicts the scope, adjust before proceeding. Otherwise move on immediately.

### Step 1 — Pre-flight

Do these in parallel — they are independent and each can fail fast.

**A. Read the relevant miniplan** (if a specific phase is in scope). Pull its acceptance criteria. These become the binary UX / correctness anchors.

**B. Verify the dev server.** Check whether `pnpm dev` is running. If not, start it via `Bash` with `run_in_background: true`. Always **pnpm** — never npm or yarn in this project. Wait until the port responds before handing control to the `playwright-test-engineer`.

**C. Make the report directory.** Create `test-reports/` (and `test-reports/screenshots/`) if they don't exist. Don't delete old reports — history is useful.

### Step 2 — Spawn the chart-ux-expert subagent

Brief the `chart-ux-expert` subagent (see [agents/chart-ux-expert.md](../../agents/chart-ux-expert.md)) with:

- The mode (`feature` / `full` / `benchmark`).
- The feature under test (or "whole library" for `full`).
- The acceptance criteria from the miniplan, verbatim.
- Device targets (the viewports from step 0).
- Cross-cutting rules from `plans/master-plan.md §5` that constrain UX demands (e.g., "no ambient ticker" means they can't demand 60 Hz animations regardless of user interaction).

Ask it to return its full report as the final message — persona matrix, numbered user stories, numbered UX acceptance criteria, trader gotchas, visual presentation checklist, open questions. Capture the numbering — the playwright agent will cite these.

Do **not** spawn the two subagents in parallel: the playwright agent's plan is derived from the UX expert's stories. If you kick off both simultaneously you're throwing away the UX expert's structure.

### Step 3 — Spawn the playwright-test-engineer subagent

As soon as the UX expert returns, brief the `playwright-test-engineer` subagent (see [agents/playwright-test-engineer.md](../../agents/playwright-test-engineer.md)) with:

- What was implemented (from step 0 / the parent context).
- **The UX expert's full report**, verbatim — do not summarize it away. Story numbering must survive.
- Any adversarial scenarios from the `chart-test-designer` if they were produced upstream (pass them through untouched).
- Execution mode (same as step 0).
- Report sink path (the file path decided in step 0).

Ask it to:
1. Detect hardware class via `browser_evaluate` probes (cores, memory, GPU).
2. Execute every UX story across the targeted viewports, using the Playwright MCP browser tools.
3. Run hardware-calibrated performance benchmarks.
4. Write the single markdown report at the sink path.
5. Return a terse final message (≤ 200 words) with pass/fail counts, top 3 failures, and the report path.

Let the subagent own the full execution. Do not drive the browser yourself during this step — that splits responsibility and loses the single clean execution log.

### Step 4 — Consolidate and surface the report

When the playwright agent returns:

1. Read the report file at the sink path. Verify it exists and is non-empty. If missing, ask the subagent to retry (do not fabricate one yourself).
2. Extract the top 3 failures, the worst-violated performance budget, and the recommendations block.
3. If UX gotchas were flagged (`manual-review` items with screenshots), list 1–2 that the user should eyeball.

### Step 5 — Respond

There are two possible callers. Respond differently for each.

**Case A — Invoked directly by the user.** Write a final message (≤ 250 words) that includes:
- The mode, viewports, and hardware class.
- Pass / fail / flaky / skipped counts.
- Top 3 failures, each one line with a specific recommendation.
- Worst performance miss (actual vs budget).
- 1–2 visual/manual-review items worth opening the screenshots for.
- The report path as a clickable markdown link.
- A single one-line next action ("fix the crosshair precision jitter before re-running" or "green across the board, ship it").

**Case B — Invoked by a parent skill (e.g., `masterplan-continue` step 9).** Return a **structured payload** the parent can consume programmatically. Keep the same content but with explicit fields:

```
REPORT_PATH: test-reports/<file>.md
MODE: feature|full|benchmark
HARDWARE_CLASS: low|mid|high
COUNTS: passed=N failed=N flaky=N skipped=N
TOP_FAILURES:
  - <scenario-id>: <one-line symptom> — recommendation: <one-line>
  - ...
PERF_WORST:
  - <metric> on <viewport>: actual=<X> budget=<Y>
RECOMMENDATIONS:
  - implement: ...
  - fix: ...
  - investigate: ...
PARENT_NEXT_STEP: <continue|loop-to-fix|abort-cycle> — <why, one line>
```

`PARENT_NEXT_STEP` is your recommendation to the parent workflow:
- `continue` — no blocking failures; parent may proceed to its next step (update trackers, commit, etc.).
- `loop-to-fix` — failures exist that the parent should address before declaring the phase done.
- `abort-cycle` — something structural is broken (dev server won't start, chart crashes on init, hardware too slow to measure meaningfully). Parent should stop the cycle and regroup with the user.

The parent agent reads this payload and routes accordingly. Do not make the parent re-read the full report to make this decision — that's what the payload is for.

## How to think

- **One cycle, one report.** If the user re-runs the skill, it's a new report, not an append. Old reports stay for history.
- **Subagents own their deliverables.** You are the orchestrator. You do not second-guess the UX expert's persona choices or the playwright agent's budget numbers mid-run. If they're systematically wrong, update the agent definitions in a separate pass.
- **Hardware class is load-bearing.** A failing frame-time budget on a "low" class is a very different decision from the same failure on a "high" class. Always surface the class when reporting.
- **Structured output for parents.** If you suspect a parent agent is driving you, use Case B. When in doubt, provide both: the human summary followed by the structured payload at the bottom under a `---` divider. Parents will parse the payload; users can ignore it.
- **Never invent results.** If the playwright subagent's report is missing, incomplete, or suspicious, loop back and re-spawn. Fabricating a report to "look finished" is the worst possible failure mode.

## Quick reference

- UX subagent: [../../agents/chart-ux-expert.md](../../agents/chart-ux-expert.md)
- Playwright subagent: [../../agents/playwright-test-engineer.md](../../agents/playwright-test-engineer.md)
- Existing adversarial matrix subagent: [../../agents/chart-test-designer.md](../../agents/chart-test-designer.md) (often already run upstream; pass its output through)
- Master plan: [../../../plans/master-plan.md](../../../plans/master-plan.md)
- Phase miniplans: `plans/01-foundation.md` through `plans/12-testing.md`
- Report directory: `test-reports/`
- Package manager: **pnpm** (never npm or yarn)
- Dev server: `pnpm dev`
