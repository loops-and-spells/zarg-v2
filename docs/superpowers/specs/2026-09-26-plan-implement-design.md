# Phase 2b-2: plan and implement on a durable reconcile loop

Date: 2026-09-26
Status: approved in conversation, pending written review
Intent: `intent/zarg.md` (accepted). This spec builds its **plan** and **implement** phases and the **reconcile** loop every phase will share.
Parents: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md`, `docs/superpowers/specs/2026-09-25-agent-runtime-design.md`, `docs/superpowers/specs/2026-09-26-core-driver-tui-design.md`
Requirements served: UX-0020..UX-0025, UX-0049..UX-0057 in `.zarg/graph`

## Intent in one paragraph

You answer the driver; a few seconds after the graph goes quiet, zarg plans every changed card, implements each plan in its own git worktree, merges them, verifies, and lands one commit (cards, plans and code together) on your branch. Obvious conflicts it settles itself; anything it cannot settle reaches you as a question from the driver. A restart resumes an unfinished pass where it stopped.

## Vocabulary

- **Reconcile loop**: the generic mechanism every phase runs: diff the upstream artifact against what was last reconciled, project the affected items, gate the result, land it, and raise findings upstream.
- **Phase**: one arrow of the pipeline. This spec builds **plan** (cards to plan files) and **implement** (plan files to code). The planner and the implementer are their agents (RLMs).
- **Pass**: one run of the loop over one upstream change. Plan and implement run chained in one pass and land one commit.
- **Finding**: an item a phase cannot project: a blocked card, a major merge conflict, verify still failing, a blocked landing. Findings join the driver's agenda.
- "Sync" is retired everywhere (preset, role, skill, `.zarg/sync.json`, spec wording).

## Packages

```
packages/
  reconcile/  @zarg/reconcile  the loop: debounced trigger, durable pass workflow, worktrees,
                               landing, findings, checkpoint. Phase-agnostic.
  core/       @zarg/core       wires the loop into the core: the plan and implement phases,
                               the `plan` and `implement` threads, findings on the driver's agenda.
  rlm/        @zarg/rlm        presets: `plan`, `implement-card`, `resolve`, `fix`; `sync` removed.
```

## Durability

- Each pass is an Effect `Workflow` (`effect/unstable/workflow`) on `SingleRunner` + `ClusterWorkflowEngine` (`effect/unstable/cluster`) with `@effect/sql-sqlite-bun` at `.zarg/run/cluster.db`. The spike (2026-09-26) confirmed on Bun 1.4.2 and Effect rc.117: a killed process resumes after the last finished Activity; a `DurableDeferred` can be answered from another process.
- Every side effect is an **Activity**, and every Activity is idempotent, since an interrupted Activity runs again: creating a worktree that exists reuses it; an RLM for a card resets the card's worktree to its base first; landing a commit that is already on the branch is a no-op.
- The workflow body itself holds no side effects (it replays on resume).
- The pass's idempotency key is `<upstream graph tree id>:<landing branch>@<base HEAD>`. A second trigger for the same state attaches to the running pass.
- Unstable APIs are accepted; they are refactored as Effect releases change them.

## The pass

```
graph write (driver, zarg tool call, git pull)
  └─ 2 s quiet ─► pass (one at a time; changes during a pass queue one next pass)
      1. affected   base = graph tree id in .zarg/reconciled.json (committed)
                    diff(base, working graph) → cards added, changed or removed,
                    plus cards that use a changed state. None → no pass.
      2. worktree   .zarg/reconcile/wt/<pass>/main from HEAD of your branch,
                    the working graph copied in, `[reconcile] setup` run once
      3. plan       per affected card, a planner RLM (Graph, Fs:read, Decisions) writes
                    .zarg/plans/<card>.md; a card that cannot be planned → finding (UX-0057)
                    removed cards: their plan files are deleted
      4. implement  per planned card, in waves of `[reconcile] max_parallel`:
                    worktree .zarg/reconcile/wt/<pass>/<card> from the pass base,
                    an implement-card RLM (Graph, Fs, Sh, Verify) with the plan as input
                    → commits in its worktree, or returns blocked → finding (UX-0024)
      5. merge      card branches merged into the pass worktree;
                    obvious conflict → resolve RLM (UX-0053); otherwise → finding (UX-0054)
      6. verify     `[reconcile] verify` in the pass worktree;
                    fails → fix RLM, at most 2 attempts (UX-0023), then → finding (UX-0055)
      7. commit     cards + plans + code + .zarg/reconciled.json
                    "feat: implement UX-0051, UX-0052" (UX-0022)
      8. land       onto your branch (below)
```

- Cards whose item failed (blocked, unplannable) are left out of the commit; the rest still land. `.zarg/reconciled.json` still records the whole graph tree the pass read; a failed card is tried again when the card changes (the driver resolving its finding) or when you ask the driver to retry it.
- `.zarg/reconciled.json`: `{ "graph": "<git tree id of .zarg/graph as reconciled>" }`. The base graph is read from git by tree id. On first run, a legacy `.zarg/sync.json` (`{ "graph": "<commit sha>" }`) is read as the base, then removed in the first commit.
- Plan file format (`.zarg/plans/UX-0051.md`), written by the planner and read by the implementer:

  ```md
  # UX-0051 Landing stops waiting
  card: <node hash the plan was written for>
  ## Approach
  ## Files
  - path — what changes
  ## Tests
  - test name — what it proves
  ## Depends on
  - UX-00NN (other cards this needs)
  ```

  A plan whose `card:` hash no longer matches its card is stale and re-planned.

## Landing

- Target: the branch checked out in your main worktree.
- Your branch moved during the pass: the pass rebases its commit onto the new HEAD and verifies again (UX-0052); an obvious conflict goes to a resolve RLM, a major one to a finding.
- Landing is `git merge --ff-only` in your checkout (UX-0049):
  - Your uncommitted edits in paths the commit does not touch stay.
  - The commit touches a path you have uncommitted edits in: landing waits, retrying on each graph change and every 60 s (UX-0050); after 10 minutes it raises a finding (UX-0051).
  - Graph files: the driver's uncommitted cards equal to the commit are staged first so the fast-forward accepts them; a card edited again during the pass keeps its newer content (saved before, restored after the fast-forward) and is reconciled by the next pass. Landing holds the graph write lock.
- A landed pass removes its worktrees and branches. A failed pass keeps its pass worktree; the last 3 are kept.

## Findings

- Stored in `.zarg/reconcile/findings.json` (gitignored; survives restarts): `{ id, kind: "unplannable" | "blocked-card" | "merge-conflict" | "verify-failing" | "landing-blocked", title, detail, about: [card ids], pass, at }`.
- The driver's agenda = plugin agenda items + findings, filtered by the thread's focus; findings come first.
- A finding clears when a later pass lands its cards, or when the driver changes a card it names.
- The driver takes a finding up like any agenda item: one question with options (UX-0025). For a merge conflict or blocked landing the options are: re-run on top of your change (recommended), keep yours and mark the card blocked, something else.

## Threads and visibility

- Passes run in the `plan` and `implement` threads (read-only for you: `zarg --thread implement`). Each shows the RLM tree (one child per card), a summary message per pass, and its findings.
- Stop on either thread interrupts the pass; its worktrees stay. The next trigger starts a new pass.

## Configuration

`.zarg/config.toml`:

```toml
[reconcile]
enabled      = true             # false turns plan and implement off for this project
quiet_ms     = 2000
max_parallel = 4                # card worktrees at once (each runs setup and verify)
setup        = "mise x -- bun install"
verify       = "mise run verify"

[roles]
plan      = "zarg-router:deepseek-v4.1-flash-exl3"
implement = "zarg-router:deepseek-v4.1-flash-exl3"
```

`roles.sync` is removed.

## Errors

- Not a git repository, detached HEAD, or a rebase or merge in progress in your checkout: no pass starts; a finding says why.
- A model or kernel failure inside one card's RLM fails that card only (a finding); the other cards still land.
- A crash or stop mid-pass: the workflow resumes after restart (crash) or ends (stop); the checkpoint moves only with a landed commit.
- A setup or verify command that cannot run (missing tool): a `verify-failing` finding with its output.

## Renames

- Presets: `sync` removed; `plan` added; `implement-card` keeps its name with the plan as input; `resolve` and `fix` added for merge conflicts and verify failures.
- Role `sync` → `plan` and `implement`. The `zarg-sync` skill → `zarg-implement` (runs one pass in-process without a core).
- The architecture spec's "Sync agent" section is reworded to the pipeline in `intent/zarg.md`.

## Testing

No real model in `mise run verify`.

- `@zarg/reconcile`, in throwaway git repos with stub phases: affected-card diff (changed states pull in their cards), debounce, checkpoint round trip and the legacy `sync.json` base, idempotent Activities, a pass resumed after a simulated crash (process killed between Activities), landing with and without uncommitted edits (overlapping and not), your branch moving mid-pass, an obvious and a major merge conflict, verify failing twice, the landing timeout.
- `@zarg/core`: findings on the driver's agenda and cleared by a landed pass; stub-mode core (`ZARG_CORE_STUB`) where a card change produces a landed commit in `git log` with its plan file.
- Live (outside `verify`): `mise run smoke:implement` in a scratch copy of the repo: one real card through plan and implement.

## Out of scope

- Specify, capture and rehearse phases (their own specs), though they reuse this loop.
- Code ownership beyond `// @card` tags (its own spec).
- Scaling passes across runner processes (the loop runs on `SingleRunner`; `SocketRunner` later).
