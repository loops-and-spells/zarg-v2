# Cards vs code: audit of the requirements graph

Date: 2026-09-29. Input for the feature sync design.

Five read-only reviewers checked all 83 cards against the code, one journey each. Each card got one verdict: MATCH, PARTIAL (the card holds only in part), DRIFT (the code does something related but different), NOT BUILT (plausible intent, no code yet) or INVENTED (nothing in the code or the plans). The evidence is file:line from each reviewer's report.

| Journey | Cards | Match | Partial | Drift | Not built | Invented |
|---|---|---|---|---|---|---|
| CLI actor (J-0005) | 12 | 8 | 4 | 0 | 0 | 0 |
| Reconcile (J-0004) | 17 | 15 | 1 | 1 | 0 | 0 |
| Talk with zarg (J-0001) | 18 | 8 | 4 | 3 | 3 | 0 |
| Set up (J-0002) | 25 | 10 | 2 | 3 | 10 | 0 |
| Watch agents (J-0003) | 11 | 5 | 5 | 1 | 0 | 0 |
| **All** | **83** | **46** | **16** | **8** | **13** | **0** |

Only about 16 cards carry `// @card` tags, and some tags sit on helper code under another card's id. Every other verdict came from searching for the behaviour.

## Drift (the card says one thing, the code does another)

- **UX-0009, UX-0011 (an answer is saved to the graph):** a picked or typed answer only goes back to the driver. The graph is written after a separate confirm of the exact change is answered "add" (`agent-zarg/src/driver.ts:25-38`).
- **UX-0015 (a picked topic becomes the focus):** it becomes a one-off task. The thread's focus and scope are fixed when the thread is created (`agent-zarg/src/thread.ts:176-177, 204-205`).
- **UX-0023 (verify fails: the Implementer goes back to the changed cards):** a separate fix step edits the merged pass worktree up to `fix_attempts` times (`reconcile/src/pass.ts:223-227`).
- **UX-0030, UX-0034 (a missing key or model is asked about):** today it is a config-file error, "set roles.X / add [providers.X] in .zarg/config.toml" (`model/src/config.ts:137`, `model/src/model.ts:54`).
- **UX-0044 (the operator stops one agent):** only the whole thread's run can be stopped, with Ctrl-C (`view-tui/src/layers.ts:147`).
- **UX-0069 (zarg's own plugins start approved):** only first-party plugins with graph-only scopes start approved. Backlog and rehearse (they have fs scopes) still ask (`plugin/src/server/host.ts:240, 403`).

## Partial (one step of the card does not hold)

- **CLI actor:**
  - UX-0007: `link` refuses a duplicate but gives no hint.
  - UX-0080: the CLI never says "in sync".
  - UX-0082: a tag in an untracked file is not found.
  - UX-0083: `affected` empties only after a commit.
- **Talk with zarg:**
  - UX-0008: the driver asks only "when there is a choice".
  - UX-0014: the "what next" options can come from intent goals, not graph gaps.
  - UX-0016: the stale check never gets the node's hash from when the question was shown.
  - UX-0075: the reply arrives whole, cut at 600 characters, and never streams.
- **Reconcile:** UX-0025: nothing wakes the driver on a new finding, and asking is up to the model.
- **Set up:** UX-0037, UX-0038: `Model.warm` exists but nothing calls it or shows progress.
- **Watch agents:**
  - UX-0040: the agent's scope is sent but never shown.
  - UX-0042: atomize confidences are never shown.
  - UX-0043: the final report is not shown in the agent's view.
  - UX-0073: "highlight" is really "open", and `agentDetail` is unused.
  - UX-0041: nested children start folded.

## Not built

- **Talk with zarg:** UX-0017, UX-0018 and UX-0019 (merging edits and conflict questions). The design spec deferred them.
- **Set up:** UX-0026..0029, UX-0031..0033, UX-0035, UX-0036 and UX-0039 (provider login and model setup). Deferred to phase 2b-3; only unused building blocks exist in `@zarg/model`.

## What it means for rehearse and triage

- **The cards are rarely invented,** but 37 of 83 (45%) do not describe what the code does: partial, drift or not built.
- **Testers roleplay every card as if it were built and exact.** They never see the code, so they "find" gaps that are already handled or that are only planned.
- **The worst plans came from the most accurate cards.** UX-0041, UX-0046 and UX-0048 all match the code, yet the testers' feedback on them led triage to invent protocols (B-07, B-08). A card that matches the code is not enough: whoever reads it also needs what the code does.
- **Missing tags hurt.** Without `@card` tags, nothing links a card to its code cheaply. Each card here took a search across the repo.
