# Triage Agent Implementation Plan (plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Feedback view drives a journey through Triage → Refine → Re-rehearse → Plan: the Triage Agent proposes card changes for the feedback that is on, the operator accepts or skips each, a tester walks the journey on the drafted cards, and the agent drafts the plan the operator backlogs.

**Architecture:** Drafts never touch the graph: a draft is an ordered list of gherkin tool calls. `@zarg/plugin-gherkin` can dry-run a draft (apply it in memory, lint it) and serve stories and steps over it. Rehearse can walk a journey over a draft and hold its findings for the caller instead of filing them. The backlog keeps each journey's stage (`.zarg/triage/<journey>.json`, committed) and shows it in the Feedback view with the stage's buttons. A new sandboxed agent, `@zarg/agent-triage` (plugin `triage`), does the agent's part of each stage when the core wakes it (the backlog's or rehearse's agenda changed).

**Tech Stack:** Bun, Effect 4, the plugin SDK (contracts, `Models`, `Agents`), `@zarg/graph/pure` (`Snapshot.applyChanges`).

**Spec:** `docs/superpowers/specs/2026-09-28-feedback-backlog-design.md` (The triage hub, stages 2–4).

## Global Constraints

- Refine never writes the graph; the Planner applies a plan's draft (plan 2).
- A proposal that fails gherkin's lints is not offered as is: the agent retries once with the findings, then shows it with its problems (accept is refused).
- Stages resume after a restart (their state is on disk).
- The Triage Agent uses the `driver` model role.
- `mise run build:plugins && mise run verify` before the last commit.

## Review Focus

1. A draft whose second change depends on the first (an added state, then a card arriving from it): dry-run and the Planner resolve the same ids.
2. A proposal the model returns as broken JSON: retried once, then the card shows "no proposal" and can be skipped.
3. Re-rehearse while another rehearse run is going: the stage waits and says so.
4. A journey whose feedback is all off: Refine refuses ("nothing on").
5. The operator backlogs a plan: the stage is `planned` with the item id; the feedback is planned.

---

### Task 1: Gherkin dry-runs drafts; stories and steps over a draft

`contract.ts`: `Draft = Array<{ tool, params }>`; `dryRun({ draft }) → { ok, problems: string[], touched: string[], messages: string[] }`; `journeys({}) → [{ id, name, cards }]`; `StoriesParams.draft?`, `StepParams.draft?`. `index.ts`: apply each tool's `run` over the snapshot (with `Snapshot.applyChanges`), then props validation and lints over the result; `stories`/`step` use the drafted snapshot when a draft is given.
- [ ] Tests: a two-step draft (add-state, then add-card arriving from it) dry-runs ok with both ids touched; a draft breaking a lint returns its problems; `step` over a draft shows the drafted Then; the graph is unchanged.

### Task 2: Rehearse walks a draft and holds its findings

Contract `@zarg/agent-rehearse/contract` `Rehearse`: `run({ focus?, draft?, file? })` and `result({ run }) → { status, findings: [{ card, kind, severity, note, on }] }`. A run with `draft` passes it to gherkin's `stories` and `step`; with `file: false` it files nothing. A finished run tells the core (`Agenda.changed`).
- [ ] Tests: a draft run's steps come from the drafted cards; `file: false` files nothing; `result` reports the findings; the run's end changes the agenda.

### Task 3: The backlog keeps each journey's stage and shows it

`stages.ts` (pure): `Stage = { journey, stage: "triage"|"refine"|"rehearse"|"plan"|"planned", proposals: [{ card, changes, answers, summary, status: "waiting"|"proposed"|"accepted"|"skipped", problems? }], draft, run?, results?: { resolved, fresh }, plan?: { title, steps }, item? }`. Contract: `stages()`, `putStage(stage)`, `feedbackOf({ journey })` (its open entries that are on). Feedback view: the stepper follows the journey's stage; a `work` text shows the stage's work (the current proposal as a diff, the run's progress and results, the drafted plan); buttons on the feedback table: Refine (r), Accept (a), Skip (s), Backlog plan (b), each refused outside its stage with a notice. Refine with nothing on is refused. Accepting appends the proposal's changes to the draft; the last decision moves to Re-rehearse. Backlog plan calls `plan` with the draft, the touched cards (refs at their current versions), the feedback that was on, and moves to `planned`.
- [ ] Tests: each button in and out of its stage; refine with nothing on; accept/skip order and the move to rehearse; backlog plan writes the item and marks the stage.

### Task 4: `@zarg/agent-triage` and the core waking it

`triage.ts` (`makeTriage(deps)`): `tick` walks every stage: refine → a proposal per card with feedback on (model JSON, dry-run, one retry with the problems); rehearse → start a draft run (`file: false`), or read its result when done (feedback whose card and kind the run no longer reports is resolved; new real findings go back to refine as fresh inputs; otherwise → plan); plan → draft the plan's title and steps (model). The plugin (`agent-triage`, `archetype: "agent"`, depends on gherkin, backlog, rehearse; scopes `models: ["driver"]`, `agents: true`) shows one agent, "Triage Agent", with its status. Core: when the backlog's or rehearse's agenda changes, invoke `triage.tick`.
- [ ] Tests over stubs for each stage; the plugin loads through the host with its dependencies; `mise run build:plugins && mise run verify` PASS; AGENTS.md and `intent/zarg.md` name the Triage Agent.
