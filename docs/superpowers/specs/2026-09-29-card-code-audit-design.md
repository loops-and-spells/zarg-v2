# Every card points to its code, or says it has none

Date: 2026-09-29 · Status: approved design, pending spec review

This is part 1 of the sync work. The other parts wait on the inbox (`2026-09-29-decision-inbox-mock.md`):
- rehearse reads each card's code;
- the `drift` feedback kind;
- triage drafts both plans for a drift.

## Problem

An audit of all 83 cards (`2026-09-29-cards-vs-code-audit.md`) found:
- 46 cards match their code.
- 16 match only in part.
- 8 have drifted from it.
- 13 are not built.

Only about 16 cards carry `// @card` tags, and some of those sit on the wrong card. So nothing links a card to its code cheaply, and no check keeps the two together.

## Outcome

Every card is either tagged in the code (built) or marked `planned` (not built yet). One fast, deterministic command reports what is out of line:
- cards without tags that are not planned;
- planned cards that have tags;
- tags that name no card.

It runs in `mise run verify`, so CI keeps the graph and the code linked.

## Design

**The card field.** A card can be `planned: true`, set with `gherkin/edit-card` (`planned: false` clears it). Render shows `Status planned` under the title. "Built" is never stored: it is the presence of tags.

**Tags.** `// @card <id>` stays the convention, with one tag per implementing unit. It goes on the function, component or handler that does what the card says, plus its test. It may also sit in `#` comments and Markdown (skills). A line may name several cards (`// @card UX-0040 UX-0041`).

**The check, a new package `@zarg/audit`** (no dependencies but `@zarg/graph`, so the CLI and the core can both use it):

```ts
audit(snapshot, tags): {
  cards: Array<{ id: string; title: string; status: "built" | "planned"; tags: Array<{ file: string; line: number }> }>
  problems: Array<
    | { kind: "untagged"; card: string }                          // no tags, not planned
    | { kind: "planned-but-tagged"; card: string; tags: [...] }   // clear the flag
    | { kind: "orphan"; id: string; file: string; line: number }  // a tag for no card (removed, or a typo)
  >
}
tags(root): Effect<Array<{ id; file; line }>>   // git grep over tracked and untracked files (not ignored ones)
```

`tags` runs `git grep -n --untracked -E '@card( UX-[0-9]+)+'`. Using `--untracked` fixes UX-0082 (a new file's tag was not found). The same function backs `zarg query code`.

**The CLI.** `zarg audit`:
- Prints JSON `{ cards, problems }` on stdout, like the other graph tools, and exits 1 when `problems` is not empty.
- `--summary` prints a line per problem and the counts (`62 built · 13 planned · 3 untagged · 1 orphan`) for people and CI logs.
- `zarg audit --card <id>` prints one card's tags. It replaces nothing: `query code` stays.

**Where it runs.**
- A root `mise run audit` task runs `zarg audit --summary`.
- `mise run verify` depends on it, so every commit is checked, and CI runs `verify` already.
- The package's own tests use fixture graphs, so the repo's graph state never fails a unit test.

**Keeping the flag in line.**
- The zarg-implement skill's steps tag the code, run `zarg audit --card <id>`, and clear `planned` when the card now has tags.
- Reconcile's implement phase does the same after a card lands.
- A card whose code is removed shows as `untagged` until someone plans it again or removes the card.

## Backfill

A one-time task, done in this work:
1. For each of the 70 built cards in the audit (MATCH, PARTIAL and DRIFT), tag the code its evidence names, plus its tests.
   - Drifted and partial cards are tagged too: their code exists, and its mismatch is feedback, not an audit problem.
   - Existing tags that sit on the wrong card move. For example, `@card UX-0020` on `affected` becomes UX-0079, and `@card UX-0022` on `checkpoint` becomes UX-0083.
2. Mark the 13 unbuilt cards `planned` through `zarg tool call gherkin/edit-card`: UX-0017..0019, UX-0026..0029, UX-0031..0033, UX-0035, UX-0036 and UX-0039.
3. Run `zarg audit` until it is clean, then add it to `verify`.

## Out of scope

Checking by model that tagged code does what its card says. Rehearse will catch that as `drift`, which comes with the inbox work.

## Errors

- **Not a git repository:** `zarg audit` fails with the same error the other git tools use.
- **A graph file that is not a node:** the audit reports it as it does today (`invalid-file`) and counts no card for it.

## Tests

- `@zarg/audit` with fixture graphs and tags:
  - built and planned cards;
  - untagged, planned-but-tagged and orphan problems;
  - a line naming two cards.
- `tags`: a tag in an untracked file is found, and an ignored file's tag is not.
- The CLI:
  - `zarg audit` exits 1 with problems and 0 when clean;
  - `--summary` prints the counts;
  - `edit-card {planned: true}` renders `Status planned`.
