# Journey stories

Date: 2026-09-28
Status: approved in conversation ("spec then build")
Touches: `@zarg/plugin-gherkin` (`planStories`, the stories contract), `@zarg/agent-rehearse` (`/rehearse`, its run params), `@zarg/agent-triage` (re-rehearse)

## Outcome

Testers walk journeys, not paths through the whole graph. A story stays inside one journey unless it tests the handoff between two, so a tester roleplays something an operator actually does, a finding points at one journey's cards, and a journey's re-rehearse walks that journey only.

## Evidence

On this repo's graph (83 cards, 5 journeys, every card in one), graph-wide edge-pair plans 75 stories (381 steps, longest 23, up to 3 journeys each). Focused on one journey it keeps every story touching that journey: Talk with zarg 257 steps, 153 of them (60%) outside it; Reconcile 131 of 269; Set up 85 of 196.

## Strategy `journey` (the new default)

- **Within each journey:** edge-pair (every step and every consecutive pair of steps) over the journey's cards only. A step is a card to a next card (its Thens lead to the next card's Given) where both are in the journey. Roots: the journey's cards whose Given is an entry state, or that no other card of the journey leads to. Loopbacks are left out, as now.
- **Seams:** for each step from a card of one journey to a card that is in another journey and not in the first, one two-card story `[from, to]`: the handoff is tested without walking both journeys.
- **Cards in no journey:** each walked alone (as teleport), so nothing is skipped.
- **Unreachable:** a journey's cards its roots do not reach, counted as today.
- **Focus:** stories through a focused card, as today (a journey's re-rehearse passes the journey's cards and the cards its draft changes).
- A card in two journeys is walked in both.

`edge-pair` (graph-wide) and `teleport` stay as they are.

## Changes

- `planStories(snap, "journey" | "edge-pair" | "teleport", focus?)`; the stories contract's `strategy` gains `journey`.
- Rehearse: `strategy` defaults to `journey`; `/rehearse` offers `journey|edge-pair|teleport`.
- The Triage Agent's re-rehearse runs `journey`.

## Testing

- Two journeys joined by a step, a branch inside one, a card in no journey: journey stories stay inside their journey and cover every step and pair; one seam story; the lone card alone.
- Focus keeps only stories through a focused card.
- This repo's graph: no journey story leaves its journey except seams.
- Rehearse's default is `journey`; the Triage Agent asks for `journey`.
