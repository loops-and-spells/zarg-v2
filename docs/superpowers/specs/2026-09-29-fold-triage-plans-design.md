# Folding a triage round into small plans

Date: 2026-09-29 · Status: approved design, pending spec review

## Problem

A triage round on a busy journey ends in one plan for every card it refined. Talk with zarg's B-02: 15 cards triaged, 60 changes, 44 cards touched, 68 feedback. Nobody can read that plan, approve it, or apply it in parts.

## Outcome

A round ends in several small plans on the Backlog, each readable on its own, ordered by what they need from each other. The operator moves any of them to Ready; the Planner applies each once the plans it waits on are Done. This is the RLM's folding (atomic test, children with dependencies, waves) applied to a round's card changes.

## Folding (agent-triage)

A worker reaches the end of a round (every card drafted, the whole draft dry-runs) and folds instead of drafting one plan.

1. **Units.** Each card the round drafted is a unit: its changes (in draft order), its summary, the feedback it answers. Cards left out are not units.
2. **Dependencies (structural, exact).** Unit B depends on unit A when B comes later in the draft and B's changes name a node A's changes create or change (a state id, a card id, a state's text A added). A node is named by `id`/`card`/`state.id` params, and a new state by its text.
3. **Concepts (driver model).** One structured call: the units (card, title, summary) and their dependencies; the answer is groups `{ title, steps, cards }`, every unit in exactly one group. Units in a dependency cycle are placed together by the fold, whatever the answer.
4. **Atomic check (decision model).** Each group of more than one unit is asked the five ROMA criteria (single deliverable, one executor, no dependent steps, no packaging, no coordination) through `Decisions`, as the RLM's `atomize` does. A group judged not atomic is split: by the model again (one retry), else structurally (item 6). A hard cap applies after: at most 5 cards per plan, split in draft order.
5. **Order.** Plan P waits on plan Q (`after`) when a unit of P depends on a unit of Q. Two plans that would wait on each other are merged.
6. **Fallback.** The model gives no usable answer: groups are the dependency components (units linked by dependencies), split in draft order at 5 cards.
7. **Changes.** A plan's changes are its units' changes in draft order. Each plan (with the plans it waits on, applied first) dry-runs; a plan that fails is merged into the plan it waits on, and the fold dry-runs again.

The fold is a pure function (`fold.ts`) over units, their dependencies and the model's groups, with the model and decision calls around it. The worker's view logs the fold: how many plans, their titles, which wait on which.

## On the Backlog (plugin-backlog)

- A new contract method `plans({ journey, plans: [{ title, steps, changes, cards, feedback, after }] })` files a round's plans together: each is an item in the Backlog lane, `after` given as indexes into the list and turned into item ids, its feedback marked planned. The stage becomes `planned` with `items: [ids]` (in place of `item`).
- Each plan's feedback is the entries its units answer (by id) or that sit on its units' cards.
- **Card-changed check.** A plan's card that one of its `after` plans also touches is not a reason for ⚠: applying the earlier plan changes it by design. The Planner's `next` uses the same rule.
- **Dropping** a plan that others wait on: they show `⇠ after B-07 (dropped)`; the Planner does not take them; the operator drops them too or Resyncs them. A journey is `planned` while any of its round's plans remain; when the last is dropped it resets to Triage.
- The drawer's Plan tab names what a plan waits on and what waits on it.

## Unchanged

The Planner (it already takes a Ready plan only when its `after` plans are Done), the board and drawer layout, Resync, triage's rounds up to the end of Refine.

## Errors

- No usable model answer: structural fallback (item 6).
- Decisions unavailable: groups are taken as atomic (as `atomize` does), the 5-card cap still applies.
- A plan that does not dry-run: merged into what it waits on (item 7); a round whose merged whole does not dry-run goes back to Refine (as today).

## Testing

- `fold.ts`: dependencies from names (created state text, edited ids); the model's groups honoured; cycles merged; the cap; `after` between plans; the fallback without a model answer; a plan that fails its dry-run merged.
- The worker: a round ends in `plans` with the fold's result; the model and Decisions stubbed (answer, no answer, not atomic).
- The backlog: `plans` files items with `after` ids and distributes feedback; ⚠ ignores cards an `after` plan touches; dropping a plan others wait on marks them; the journey stays planned until the last plan goes.
