# Rehearse and triage with the code; drift as a decision (spec 4 of 4)

Date: 2026-09-30 · Status: written by the implementer on the operator's behalf. It is part 2 of `2026-09-29-card-code-audit-design.md` (part 1, tags and `zarg audit`, is done), on the inbox of specs 1–3.

## Problem

Testers and triage never saw what zarg does. They "found" gaps the code already handles, or only plans, and triage drafted protocols zarg doesn't have (B-07, B-08).

## Design

1. **A card's code, for plugins.** `Entities.code(ref)` returns, for a gherkin card, each `@card` tag's file and line and the code after it: up to 40 lines, stopping early at the next tag, and redacted. It is served by the host from one `git grep` (`@zarg/audit`'s `tags`), cached for a few seconds. It needs the same `entities.read` scope as reading the card.
2. **Stories cut at unbuilt cards.** Gherkin's `step` also says whether a card is `planned`. Rehearse cuts each story at its first planned card and at its first card with no code (untagged and not planned). The run notes each cut ("UX-0044: no code tagged and not planned: tag it or mark it planned"), so testers only walk what is built.
3. **Testers see the code.** Each diagnosed step's prompt carries "What zarg does now" (the step's code, 60 lines at most). A new feedback kind, `drift`, means the step as written and what zarg does now differ.
4. **Triage sees the code.** Each card's proposal prompt carries the card's code, so it drafts against what exists.
5. **Drift is a decision.** Rehearse files `drift` with the "ask" route. The backlog raises a `drift` topic, not spec 3's "keep this on?", with the card, the note and the code as evidence. It offers two answers:
   - **Reword the card:** the entry stays on, with the operator's note "reword the card to match the code". The next Refine drafts the card change, with the code in its prompt.
   - **Change the code:** the backlog files a **code plan** in the Backlog lane (`kind: "code"`, no graph changes, the card and the entry). The entry is planned.
6. **Code plans are the operator's to carry out.** The Planner never takes them. The board shows "code"; the drawer says "change the code so UX-… does what it says (zarg-implement, or by hand); move it to Done when it does". A `plan` topic ("B-14 is a code change") offers **Done** (the plan moves to Done and its feedback closes) and **Drop**.

## Guards

- **A card with no tags and not planned is never walked.** The run says why, so the audit and rehearse agree.
- **The code for plugins is read-only** and limited to tagged ranges. Nothing outside the repo is read, and nothing ignored or in `docs/`.
- **A drift answer whose entry moved on** (planned, closed) changes nothing and says so.
- **Older plans** with no `kind` are graph plans.

## Out of scope

- The Planner forcing code plans into a reconcile pass. That needs reconcile to take cards the graph did not change; it is its own change.
- The model checking a card against its code.
