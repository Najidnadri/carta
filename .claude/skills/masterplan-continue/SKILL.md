---
name: masterplan-continue
description: Drive the next phase of the Carta charting library's master plan end-to-end — read the master plan, confirm scope with the user, create a phase plan, implement it, guard patterns with ESLint, design worst-case test scenarios, run Playwright visual/interaction tests across mobile/tablet/laptop viewports, and update trackers. Use this skill whenever the user says anything like "continue with the masterplan", "let's move on to the next phase", "resume the plan", "work on the next phase of Carta", "pick up where we left off on the chart library", "progress the plan", or any phrasing that implies advancing the master plan in `plans/master-plan.md`. Trigger aggressively — this workflow is carta-specific and the user expects the full orchestrated loop (plan → approve → implement → test), not a quick edit.
---

# Carta master-plan continuation

This skill orchestrates one full cycle of work on the Carta charting library's master plan: reading progress, aligning on scope, planning, implementing, linting, stress-testing, and updating trackers. One invocation = one phase (or sub-slice of a phase if the user wants to split it).

## Why this exists

Carta is a pre-1.0 PixiJS charting library with a phase-gated roadmap in [plans/master-plan.md](../../../plans/master-plan.md). Each phase has strict acceptance criteria and the user has been burned by AI that skipped the "align first" step and built the wrong thing. This skill enforces: **align → plan → approve → implement → lint → stress-test → update trackers**, in that order, with no shortcuts.

## What makes this workflow non-negotiable

- **Alignment before planning** — Carta phases are sequential (see master-plan §4). A misunderstood phase wastes multiple subagent spawns. The pre-plan research subagent exists to kill ambiguity early.
- **Plan mode is used literally** — not "I'll just describe my plan in chat". Use `EnterPlanMode` so the user sees the plan in the UI and approves it with `ExitPlanMode`.
- **Ruthless chart testing** — Carta is a charting library. Broken rendering = broken product. The test-design subagent generates adversarial data (empty arrays, NaN, +/-Infinity, single-point, millions of points, mis-ordered time, duplicate timestamps, timezone-skew, extreme values that blow up GPU float precision). Graceful degradation under bad input is a feature, not an afterthought.
- **Playwright across viewports** — Charts render differently at mobile/tablet/laptop breakpoints. Touch gestures (pinch, long-press crosshair) only matter on touch viewports. Test all three.
- **Trackers are source of truth** — The master plan and each miniplan have status tables. They must reflect reality before the loop ends, or future sessions will re-work completed phases.

## The loop

### Step 0 — Confirm the user wants to run this loop

The user's trigger phrase (e.g., "continue with the masterplan") is enough to start. Don't re-ask whether to proceed, but **do** state the phase you're about to work on so they can redirect. Example: "Reading the master plan now — last marked 🟨 phase is 03 Viewport. I'll target that unless you say otherwise."

### Step 1 — Read the master plan and current phase

Read [plans/master-plan.md](../../../plans/master-plan.md). Identify:
- The phase table (§4). First 🟨 `in progress` phase wins; if none, first ⬜ `not started` phase.
- Cross-cutting rules (§5). These apply to EVERY phase.
- The selected phase's miniplan file (e.g., [plans/03-viewport.md](../../../plans/03-viewport.md)).

Read the full miniplan. Note its acceptance criteria — those are the binary checks you'll validate at the end.

**Output to user (short):** which phase, what % of its tasks appear done from the tracker, what the next logical sub-slice is if the phase is large.

### Step 2 — Spawn the implementation researcher, THEN ask the user to confirm scope

Before planning, you need two things: (a) a deep-research reference covering the implementation choices involved, and (b) the user's explicit confirmation that your understanding matches theirs.

Do these **in parallel** so the user isn't waiting on research:

1. Spawn the `implementation-researcher` subagent (see [agents/implementation-researcher.md](../../agents/implementation-researcher.md)). Brief it with: the phase name, the miniplan contents, any cross-cutting rules that constrain the implementation, and the specific open questions you see (e.g., "how should pinch-zoom interact with the window:change event throttle?"). Ask it to report back with a ranked set of implementation approaches, their trade-offs, edge cases, and references to `.research/pixijs-charting-guide.md` or `.research/advanced-features.md` where relevant.

2. In the same message, ask the user (use `AskUserQuestion` if there are discrete choices) to confirm the scope of this cycle. Present:
   - What you think this cycle's slice is (sub-scope of the phase, if the phase is big enough to split).
   - Any assumptions you're making about behavior that isn't fully pinned down in the miniplan.
   - Any decisions that will require a judgment call (e.g., "should pan inertia survive window:change events or cancel on programmatic pan?").

Do not move to step 3 until the researcher has reported AND the user has confirmed scope. If the user's answer invalidates your assumptions, loop back — re-brief the researcher if the problem space shifted.

### Step 3 — Enter plan mode

Call `EnterPlanMode`. Inside plan mode, you can continue reading files and asking questions but you cannot edit. Use the researcher's report + user's confirmation to draft a plan.

### Step 4 — Draft the plan

The plan must include:
- **Goal** — one sentence, matching the miniplan's goal (or sub-goal).
- **Files touched** — explicit paths, new vs modified.
- **Key decisions** — the forks from the researcher's report that you've resolved, with one-line justification each.
- **Acceptance criteria for THIS cycle** — pulled from the miniplan, scoped to what you'll finish this loop.
- **Test strategy** — what unit tests (vitest) you'll add, what Playwright scenarios you'll exercise, what adversarial data you'll throw at it.
- **Risks / unknowns** — anything you're still uncertain about.

Keep it concrete. No "improve error handling" — name the function.

### Step 5 — Approval loop (this is where most cycles get stuck)

Call `ExitPlanMode` with your plan. The user will approve, reject, or (most commonly) come back with revisions.

If the user returns with feedback **without** approving:
- Re-enter plan mode (`EnterPlanMode`).
- Revise the plan.
- Exit plan mode again.
- Repeat.

Do not start implementation until the user explicitly approves. "Sounds good" or accepting via `ExitPlanMode` counts; a question does not. If you're unsure, ask.

### Step 6 — Implement

Now you can edit. Work in small, verifiable chunks. A few rules specific to Carta:

- Use **pnpm** for any package operation (installs, scripts). Never npm or yarn.
- Keep the Pixi ticker off — `autoStart: false, sharedTicker: false`. Render on demand via the dirty-flag pattern (master-plan §5).
- Typed events only (payloads in `src/types.ts`).
- No `console.log` in committed code. Use an injectable logger.
- No backwards-compat shims — this is pre-1.0 with no users yet.
- Follow the layered scene graph: `bgLayer / gridLayer / plotClip(seriesLayer, overlays, drawings) / crosshairLayer / axesLayer / legendLayer / tooltipLayer`. `isRenderGroup = true` only on `seriesLayer`.

When you finish each chunk, run the relevant typecheck or vitest spec locally before moving on. Don't batch all the testing to the end.

### Step 7 — ESLint guard

Run `pnpm lint`. If it fails:
- Fix the actual issue, not the rule. (Disabling a rule inline is a last resort and must be justified in the plan's "key decisions".)
- If the lint config itself is missing a rule that would have caught the issue, flag it to the user and offer to add the rule.

Run `pnpm typecheck` as well — TypeScript errors count as lint failures for our purposes.

### Step 8 — Spawn the chart-test-designer subagent

Spawn the `chart-test-designer` subagent (see [agents/chart-test-designer.md](../../agents/chart-test-designer.md)). Brief it with: what was implemented this cycle, the series types / features affected, and the acceptance criteria. Ask it to produce:

- A matrix of test scenarios grouped by category: **normal, boundary, adversarial, scale, interaction, viewport**.
- For each scenario: the input data shape (generated inline or as a fixture), the expected behavior, and the failure mode the test is trying to catch.
- Random-data generators for the chart (pnpm scripts or inline). Seeded so runs are reproducible.
- Specific adversarial cases: empty arrays, single point, NaN / Infinity / -Infinity values, duplicate timestamps, non-monotonic time, gaps larger than the visible window, values outside representable float32 precision, intervals smaller than 1ms, intervals larger than a year, start > end, zero-width container.
- Performance canaries: what's the frame time / memory ceiling we're willing to accept for (say) 1M bars? What happens at 10M?

The subagent's deliverable is a test plan document (plus optional fixture generators), not a finished test suite — you'll run the scenarios in step 9.

### Step 9 — Playwright validation across viewports

Use Playwright MCP (`mcp__playwright__browser_*` tools) to drive the demo. For each viewport:

| Viewport | Size | Interactions to exercise |
|----------|------|--------------------------|
| Mobile   | 390×844 (iPhone 14-ish) | touch pan, pinch zoom, long-press crosshair, orientation change |
| Tablet   | 820×1180 (iPad-ish)     | touch pan, pinch zoom, mouse+touch hybrid if applicable |
| Laptop   | 1440×900                | mouse drag pan, scroll-wheel zoom, hover crosshair, keyboard (if wired) |

For each viewport:
1. `mcp__playwright__browser_resize` to the target size.
2. `mcp__playwright__browser_navigate` to the dev server (`pnpm dev` serves at the usual vite port — start it if not running).
3. Feed each adversarial scenario from step 8 into the demo (either via URL params if the demo supports them, via the demo's dataset picker, or via `mcp__playwright__browser_evaluate` to call `chart.supplyData(...)` directly).
4. Take a screenshot with `mcp__playwright__browser_take_screenshot`. Compare visually to expected behavior. Collect console errors via `mcp__playwright__browser_console_messages`.
5. Exercise the interactions listed for that viewport. Record what broke.
6. If a scenario crashes or hangs the tab, flag it — Carta's "weird data should degrade gracefully" tenet means no scenario should be able to take the browser down.

Report findings. If anything broke, loop back to step 6 to fix before declaring the cycle done.

### Step 10 — Update trackers

Two files need updates:
- **Master plan** — update the phase's status in the table (§4). ⬜ → 🟨 while work is in progress, 🟨 → ✅ only when every acceptance criterion for the phase is satisfied. Don't fake a ✅ just because this cycle finished — if the phase has more slices, it stays 🟨.
- **Miniplan** — update the phase-specific tracker (usually a task checklist). Tick the boxes this cycle completed. Add a "cycle N notes" section at the bottom if there were surprises worth recording for future sessions (e.g., "Safari iOS ignores pointerevents on contextmenu; worked around by…").

Then summarize for the user: what changed, what's still outstanding in this phase, what the next cycle will tackle.

## Quick reference

- Master plan: [plans/master-plan.md](../../../plans/master-plan.md)
- Phase miniplans: `plans/01-foundation.md` through `plans/12-testing.md`
- Research: [.research/pixijs-charting-guide.md](../../../.research/pixijs-charting-guide.md), [.research/advanced-features.md](../../../.research/advanced-features.md)
- PixiJS docs: https://pixijs.com/llms.txt
- Package manager: **pnpm** (never npm)
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Tests: `pnpm test`
- Dev server: `pnpm dev`

## When NOT to use this skill

- The user is asking a one-off question about the chart API (just answer it).
- The user wants to refactor one file without advancing the plan (just do it).
- The user is debugging a specific bug unrelated to phase progression (debug it).

This skill is heavy — only run the full loop when the user is actually advancing the plan.
