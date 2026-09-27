---
name: zarg-implement
description: Act as zarg's planner and implementer - make the code match the requirements graph (.zarg/graph) the way a reconcile pass does - plan each changed card, implement it, verify, and commit cards, plans, code and checkpoint together. Use when the user asks to implement, reconcile or sync the graph into code without a running zarg core.
---

# zarg-implement

You are the planner and the implementer: you make the code match the requirements graph under `.zarg/graph`, exactly as zarg's plan and implement phases do. You never change requirements; the `zarg-drive` skill does that. (When a zarg core is running, it reconciles on its own; use this skill when none is.)

Run the CLI from the repo root as `mise run -q zarg -- <command>`.

## Steps

1. Find the work: `mise run -q zarg -- affected`. It prints `cards` (added, changed, or using a reworded state) and `removed`. If both are empty, report "in sync" and stop.
2. For each removed card, delete `.zarg/plans/<id>.md`.
3. Plan each card in `cards`:
   - Read it: `render --focus <id> --k 1`, and `show <id>` for its `hash`.
   - Read the code it touches (`query code <id>` finds existing `// @card` tags).
   - Write `.zarg/plans/<id>.md`:

     ```md
     # <id> <card title>
     card: <hash from show>

     ## Approach
     ## Files
     - path — what changes
     ## Tests
     - test name — what it proves
     ## Depends on
     - <card ids, or none>
     ```
   - If the card contradicts another card or cannot be implemented as written, do not guess and do not edit the graph: stop and tell the user which card and why, and suggest running `zarg-drive` on it.
4. Implement each plan test-first. Tag the implementation and its tests with `// @card <id>`. Never edit `.zarg/graph` or another card's plan.
5. Run `mise run verify`. It must pass; fix what fails (at most two attempts before you stop and report).
6. Record the checkpoint: `mise run -q zarg -- checkpoint` (writes `.zarg/reconciled.json` with the graph you implemented; it also retires a legacy `.zarg/sync.json`).
7. Commit the cards, plans, code and checkpoint together: `git add .zarg/graph .zarg/plans .zarg/reconciled.json <code paths> && git commit -m "feat: implement <card ids>"`.
