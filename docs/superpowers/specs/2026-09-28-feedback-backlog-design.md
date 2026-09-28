# Feedback, triage and the Backlog

Date: 2026-09-28
Status: design approved in conversation (mockups: Feedback triage hub, Backlog option D), pending written review
Mockups: `packages/view-tui/mockups/feedback.tsx` (uncommitted), published as "Feedback and Backlog"
Builds on: `docs/superpowers/specs/2026-09-28-entities-design.md` (refs, versions, the `Entities` service)
Touches: new `@zarg/plugin-backlog`, new `@zarg/agent-triage`; `@zarg/agent-rehearse` (feedback leaves it), `@zarg/plugin-gherkin` (card versions), `@zarg/view` and `@zarg/view-tui` (a `board` section kind, toggle rows), `@zarg/agent-zarg` (the findings gate), the core (the Planner applies a plan)

## Outcome

Testers' feedback outlives the run that found it. Each entry is tied to the exact version of the card the tester saw, so it goes stale the moment that card changes and is never acted on out of date. The operator triages feedback by journey in one place, Feedback: the Triage Agent takes the first pass at every step and the operator confirms or overrides. Nothing is implemented until a journey's feedback has been triaged, refined into the graph, re-rehearsed clean and planned; only a plan reaches the Backlog, a kanban the agents move from Ready to Done.

## Lifecycle

```
testers ──► Feedback (per card version)
              │  Triage: each entry on/off (agent first, operator flips)
              │  Refine: drafted card changes for the entries that are on
              │  Re-rehearse: the whole journey on the drafted cards
              │  Plan: one plan for the journey, drafted by the Triage Agent
              ▼
            Backlog ─ Ready ─ Running ─ Review ─ Done
                      (Planner Agent applies the drafted changes to the graph;
                       the reconcile loop implements them; the operator accepts)
```

- **Feedback is not work.** It is evidence. Work starts only when a plan is backlogged.
- **Refinements are drafts until a plan runs.** Refine does not write the graph; the drafted changes live with the journey's triage and travel in the plan. The graph changes when the Planner Agent takes the plan (Ready → Running), so the reconcile loop implements only planned work.
- **Agents drive, the operator gates.** Each stage has an agent default (toggles, proposals, the plan); the operator accepts, overrides or leaves it. The operator can also move board items by hand.

## Personas

- **The Triage Agent** (new, internal): triages a journey's feedback, proposes refinements, re-rehearses the journey and drafts its plan. Added to the persona list in `intent/zarg.md`.
- **The Planner Agent** (existing): takes a Ready plan, applies its changes to the graph, and follows the reconcile pass.
- **The Implementer Agent** (existing): implements the changed cards (the reconcile loop, unchanged).
- Testers (rehearse) and the operator as today.

## Card versions

- A card's **version** covers everything a tester reads: the card node, the text of its Given, And and Then states, and the names of its `by` personas. Rewording a state the card uses changes the card's version.
- The version is the `gherkin/card` entity's version (Entities spec): gherkin's card provider hashes the card, its states' text and its personas' names.
- Feedback and plans hold refs with the version they saw (`gherkin/card:UX-0062@3f9a1c20b7e4`); `Entities.changed` tells them the card moved on.
- A version is shown as `@` plus its first 4 characters (`UX-0062 @3f9a`).

## Feedback

- **An entry** (entity `backlog/feedback`): `{ id, ref (with the version the tester saw), journey?, persona, kind, severity, note, from: { agent, run }, count, state, triage? }`.
  - `ref` names any entity, so feedback is not limited to cards (a card, a state, a persona, a journey).
  - `id`: `F-` plus a hash of the ref (with its version), kind and the normalised note, so the same report on the same card version is one entry (its `count` rises; its triage stays as the operator left it).
  - `state`: `open` (current version), `stale` (the card's version changed since), `planned` (in a backlogged plan), `closed` (resolved by a re-rehearse, or its plan is Done).
  - `triage`: `{ on, why, by: "agent" | "operator" }`.
- **Stale**: whenever the graph changes, the plugin asks `Entities.changed` for each open entry's ref; a changed or removed entity makes its entries stale. Stale entries leave Open by themselves and are re-tested by the next Re-rehearse of their journey (they close if the problem is gone, or come back as new entries on the new version).
- **Who files feedback**: rehearse's testers, through the plugin-backlog contract (`feedback.add`). Any plugin that depends on the contract may file feedback.
- **Storage**: one JSON file per entry under `.zarg/feedback/`, committed to git (not ignored). Written through the Files power.

## The triage hub (the Feedback view)

A nav item, **Feedback**, owned by plugin-backlog. Left: every journey with its open count and stage. Top: the stepper **Triage → Refine → Re-rehearse → Plan** for the selected journey. Right: the stage's work. A journey's triage state is one file, `.zarg/triage/<journey>.json` (committed): stage, toggles, drafted changes, the re-rehearse run, the drafted plan.

1. **Triage.** Each entry is a row with a toggle (`[●]` on, `[ ]` off). The Triage Agent sets every toggle first, with a one-line reason (`agent: off · already said on UX-0034`), using rehearse's existing triage decision (real, route) on the card as it is. The operator flips any (space); an override is marked (`you: on`). Off entries stay, dimmed, for that card version. **Refine N on** (r) moves on with only the entries that are on.
2. **Refine.** For each card with entries on, the Triage Agent proposes graph changes (reworded states, new cards, `by` changes) as gherkin tool calls, and names which entries each change answers. The operator **Accept**s (a), **Revise…**s by telling the agent what to change (e), or **Skip**s the card (s). Accepted changes are added to the journey's draft (not the graph). The gherkin lints run on the drafted graph; a proposal that fails them is shown with the lint's message and not accepted.
3. **Re-rehearse.** A tester walks the whole journey on the drafted graph (the snapshot with the draft applied). Entries the run no longer reports close (✓ resolved); new reports appear as new entries on the drafted versions (◇ new). Any new entry that the Triage Agent turns on sends the journey back to Refine.
4. **Plan.** When the journey re-rehearses clean, the Triage Agent drafts the plan: a title, the cards it changes, the entries it closes, and numbered steps. The operator confirms (**Backlog plan**, b) or sends it back (**Refine more**, r); a plan left unanswered is backlogged by the Triage Agent on its next pass over the journey. Planned entries become `planned`.

Keys and buttons follow the view SDK's rules (buttons in the view, keys on the status line). Each stage is resumable: closing the TUI or restarting the core resumes the journey where it was.

## The Backlog (kanban)

A nav item, **Backlog**, owned by plugin-backlog; the board is option D of the mockups.

- **Items** are plans (entity `backlog/item`, commands `move`, `park`, `accept`, `drop`): `{ id: "B-NN", title, journey, cards: [{ ref (with the version the draft started from), to: version }], changes (the drafted gherkin tool calls), feedback: [ids], steps: [text], status, agent?, links: { after?: [ids] }, events: [{ what, by }] }`. One JSON file per item under `.zarg/backlog/`, committed.
- **Lanes**: Backlog, Ready, Running, Review, Done. A backlogged plan lands in **Ready** (it has been triaged already; **Backlog** holds plans the operator parked with **Park**).
- **Who moves items**:
  - Ready → Running: the Planner Agent takes the oldest Ready item whose `after` items are Done, applies its changes to the graph through the gherkin tools (one commit, `req: <item title> (B-NN)`), and notifies the reconcile loop.
  - Running → Review: when the reconcile pass that implemented the item's cards lands.
  - Review → Done: the operator accepts (the drawer's **Done**), or the item's journey re-rehearses clean on the implemented code.
  - A failed pass or a lint failure on apply returns the item to Ready with the reason as an event, and asks for attention.
  - The operator can move any item by hand (⇧←→).
- **A card changed under a plan**: when a card in a Ready or Backlog item changes version after the plan was drafted, the item shows ⚠ card changed and the Planner Agent does not take it until the operator re-plans (back to the journey's Refine) or accepts it as is.
- **Board view** (option D):
  - Lanes side by side, each its own scroll container with a scrollbar on its right edge.
  - `◂` folds a lane to a 3-column strip: its count on the header row (in line with the other lanes' counts), `▸`, then its name top to bottom. `z` folds or unfolds the lane under the cursor, `Z` folds every other lane. Folded lanes are remembered per view.
  - Cards: a severity stripe on the left; `B-NN UX-NNNN ◇n` on top (item, first card, feedback count); the whole title wrapped; the persona; the agent running it (`⠼ Planner`), `⇠ after B-NN` when blocked, `⚠ card changed`. No times anywhere.
  - Toolbar: search (BM25 over title, cards and feedback notes), filters by journey, persona and agent, **Show done**, **Lanes by agent** (sub-groups Running by agent).
  - ⏎ opens the item's **drawer** (a sheet on the right edge): title, card and persona, status buttons (context-sensitive: → Ready, Park, Done, Drop), the feedback it closes, the drafted card changes, links, events (in order, no times).

## Rehearse and testers

- Rehearse no longer triages or sends to zarg. Its `apply` action, the `applying`/`resolved` lists and its agenda items go; `dismissed.json` moves into the feedback entries' triage.
- Testers file feedback through the plugin-backlog contract with the card's version.
- **The run view** becomes a rollup: the progress gauge; a Testers table (tester, persona, journeys, steps, feedback filed, still open, likes); feedback by journey; **Open in Feedback** and **Rehearse again**.
- **The tester view** is read-only: its steps (⚑ where it found something) and a Feedback tab listing what it filed with where each entry is now (open, off, planned B-NN, stale, closed). One button: **Open in Feedback**.
- Rehearse gains two parameters the Triage Agent uses: `journey` (walk one journey) and `draft` (node changes applied over the snapshot before the testers read it).

## Packages

- `@zarg/plugin-backlog` (sandboxed service plugin, contract `@zarg/plugin-backlog/contract`): the feedback and backlog stores, the triage state, the Feedback and Backlog views and nav items, the drawer sheet, stale detection on graph changes. Scopes: `fs write .zarg/feedback/** .zarg/backlog/** .zarg/triage/**`, graph read, `entities: { read: ["gherkin/*"] }`, agents, views. Serves `backlog/feedback` and `backlog/item`. Depends on gherkin.
- `@zarg/agent-triage` (sandboxed agent, plugin name `triage`): the Triage Agent. Depends on gherkin, rehearse and backlog. Uses the decision model for toggles and the driver model for refinements and plans.
- The Planner Agent's apply step runs in the core's plan phase (it already owns graph commits and the reconcile notify).
- `@zarg/view`: a `board` section kind (lanes of cards with fold and per-lane scroll state in the view UI) and table rows with a toggle column (`toggle: true`; space flips; the plugin gets `act "toggle"`). `@zarg/view-tui` renders both.
- `@zarg/agent-zarg`: the findings gate (`Findings.take` / `resolve`) is retired with rehearse's apply; the driver keeps its own graph writes.

## Errors

- A card removed while entries are open: entries go stale; the journey's triage says which card went.
- A drafted change that no longer applies (the graph moved under the draft): the Planner Agent refuses the item with the conflicting node and returns it to Ready with ⚠.
- The decision or driver model is unavailable: the Triage Agent leaves the stage waiting and says why in the view; the operator can still flip toggles and move items by hand.
- Two journeys drafting changes to the same card: allowed; the second plan to run re-checks versions (⚠ card changed) before applying.
- A malformed entry or item file: skipped with a problem on zarg's agenda naming the file.

## Testing

- Feedback: the same report twice is one entry with count 2 and its triage kept; a version change makes it stale; re-rehearse closes or renews it.
- Triage: the agent's toggles come from rehearse's triage; an operator flip survives the agent's next pass.
- Refine: accepted changes land in the draft, not the graph; a lint failure refuses the proposal.
- Re-rehearse: testers read the drafted graph (a drafted Then appears in their steps).
- Backlog: Ready → Running applies the changes in one commit and notifies reconcile; a stale draft is refused; `after` holds an item back.
- Views: the board folds and scrolls per lane; the count stays on the header row; toggle rows flip; the Feedback stepper follows the journey's stage.
- Rehearse: no apply action; testers file feedback with versions; the run and tester views render without triage.

## Scope and order

In: everything above. Built in three plans, each shippable on its own:

1. **Feedback** (after Entities): plugin-backlog's feedback store and stale detection, rehearse filing feedback (its triage and apply removed), the Feedback view's Triage stage with toggles (agent defaults from rehearse's triage), the rehearse rollup and read-only tester views.
2. **Backlog**: the `board` section kind and its TUI renderer (option D), backlog items and the drawer, the Planner Agent's apply step and the lane moves, manual moves.
3. **The Triage Agent**: Refine, Re-rehearse (rehearse's `journey` and `draft`), Plan, and the agent defaults at every stage.

Out: a web renderer for these views, cross-repo backlogs, time-based metrics.
