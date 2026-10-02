# Intents in the graph: what the product is for, reconciled into its journeys

Date: 2026-10-02 · Status: approved design (the operator: graph only, atomic, an intent agent reconciles into plans), pending spec review. Terms: `docs/taxonomy.md`

Reference: the AI-native SDLC playbook's "capture intent" (an intent is the originator's problem, proposed outcome, affected users, constraints and open questions, captured before design). Here it lives in the graph, not in a file.

## Problem

- **Intent sits outside the graph.** It lives in `intent/zarg.md`, a hand-kept file. Nothing links a journey to the intent it serves.
- **A changed intent changes nothing downstream.** No one notices that a goal has no journey, or that a journey serves nothing.
- **"What next"** reads a frontmatter list, not the product's own goals.

## What this changes

- **Intents are graph nodes, atomic:** an intent holds goals, constraints and open questions, one sentence each.
- **Journeys serve goals;** constraints bound journeys or cards.
- **Changes flow down on their own.** A changed, new or uncovered statement starts an intent agent's round, which drafts journey and card changes as small plans on the Backlog, with open decisions sent to the inbox. From there the existing pipeline takes over: Ready, the Planner, reconcile, code.

## The model (`plugin-gherkin`)

| Node | Id | Props | Rules |
|---|---|---|---|
| intent | `I-0001` | `title`, `problem` (prose: context, not traced), `status`: draft or accepted | a title of at most 10 words |
| goal | `O-0001` | `text` | one sentence, at most 20 words, no "if", one idea (the card lints). Not a card's outcome (its Then): see the taxonomy |
| constraint | `K-0001` | `text` | the same |
| question | `Q-0001` | `text`, `answer?` | open until answered |

Edges:
- `gherkin/has`: intent → goal, constraint or question. Each statement has exactly one intent.
- `gherkin/for`: intent → persona (the affected users).
- `gherkin/serves`: journey → goal (many to many).
- `gherkin/bounds`: constraint → journey or card.

Tools (through `zarg tool call` and the write pipeline, with the lints):
- `add-intent`, `edit-intent`;
- `add-goal {intent, text}`, `add-constraint {intent, text}`, `ask-question {intent, text}`, each with `edit-…`;
- `answer-question {id, answer}` (the answer can become a goal or a constraint in the same call);
- `link`/`unlink` for `serves`, `bounds` and `for`;
- `remove`.

**Versions.** Statements are entities with versions, like cards, so plans and feedback pin them.

**Agenda** (gherkin's own):
- a goal no journey serves;
- a journey that serves no goal;
- an open question;
- an intent with no goal.

**`zarg audit`** reports, in addition to its card checks:
- `uncovered` (a goal nothing serves);
- `unserving` (a journey that serves no goal).

These are warnings, not errors, until the migration is done, so `verify` stays green.

## Authoring

- **In conversation.** The operator talks to zarg. The driver proposes statements ("I'd record this as a goal: …") through its confirm-before-write, as it does for cards. It also asks the open questions.
- **In the Intent view:**
  - `a` adds a statement under the highlighted intent;
  - `e` edits the highlighted statement;
  - `⏎` on a question answers it;
  - `x` removes a statement, with a confirm.

## The Intent view (`plugin-gherkin`, a nav item like Journeys)

- **A list of intents,** each with:
  - its problem;
  - its goals, each with coverage: the journeys serving it, or "◇ no journey";
  - its constraints, each with what it bounds;
  - its open questions.
- **Beside the list:** the highlighted statement, its journeys and their cards, and the plans in flight for it (from the Backlog).

## Reconcile: an intent agent (`packages/agent-intent`, plugin `intent`, sandboxed, triage's pattern)

- **What starts a round** (by comparing statement versions with the agent's checkpoint, `.zarg/intent/checkpoint.json`):
  - a changed goal or constraint;
  - a new goal;
  - a goal left uncovered;
  - a journey that serves nothing.
- **What a round does:**
  1. Read the statement, the journeys serving it (or bounded by it), and their cards with their code (`Entities.code`).
  2. Draft card and journey changes (driver model, no reasoning, as triage does). Each change is dry-run through `gherkin.dryRun`.
  3. Fold the changes into small plans with dependencies (triage's `fold`). Each plan says which statement it serves, and lands in the Backlog lane through `backlog.plans`.
  4. Send the inbox what it cannot decide:
     - "O-0007 has no journey: add to Watch agents, or a new journey?"
     - "K-0002 conflicts with S-0045: keep the constraint, or change the card?"
- **After a round:** the checkpoint moves forward. The agent works rounds one at a time, has workers like triage, and its view shows each round.
- **Guards:**
  - Drafts never touch the graph: the Planner applies plans.
  - A round for a statement that changed again restarts.
  - A removed statement's plans in Backlog are dropped, and its journeys become `unserving` (an agenda item).

## Migration

- **`I-0001` from `intent/zarg.md`:**
  - its title and problem become the intent's props;
  - its expected outcomes become goals `O-…`;
  - its safety and durability lines become `K-…`;
  - its personas are linked with `for`;
  - its `next` items become goals with no journey yet.
- **`serves` links:** the intent agent proposes them for J-0001..5, and the operator confirms them in the inbox.
- **zarg's "what next"** reads uncovered goals instead of frontmatter. `agent-zarg/src/intent.ts` and the `intent/**` read scope go.
- **The file is deleted** once the migration commit lands. `audit`'s `uncovered`/`unserving` become errors after that.

## Out of scope

- Capabilities or epics between goals and journeys (add them if a goal proves too big for one journey).
- Any `.md` rendering or ingesting.

## Tests

- **gherkin:**
  - each tool, and its lints;
  - edges (one intent per statement);
  - the agenda items;
  - render;
  - versions.
- **audit:** `uncovered`, `unserving`.
- **The view:**
  - coverage marks;
  - `a`, `e`, `⏎` and `x`.
- **agent-intent,** with the model stubbed:
  - a changed goal starts a round;
  - drafts are dry-run;
  - plans are filed with their statement;
  - inbox topics for undecided cases;
  - the checkpoint moves;
  - a removed statement drops its plans.
- **The migration:** I-0001's statements and links exist, and "what next" lists the uncovered goals.
