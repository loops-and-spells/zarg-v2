# Personas in the graph

Date: 2026-09-27
Status: design approved in conversation (JSON example reviewed; "support multiple by"), pending written review
Touches: `@zarg/plugin-gherkin` (node type, edge, tools, lints, render, agenda, stories), `@zarg/agent-rehearse` (testers), the Driver Agent (asks about personas), `intent/zarg.md` (edge personas only)

## Outcome

zarg knows who acts in each card. Personas are nodes in the requirements graph, defined and checked by zarg, and every card names the persona(s) who act in it. Rehearse runs one tester per persona, each roleplaying that persona and judging only the steps it acts in, instead of guessing testers from the intent's prose.

Today rehearse reads the intents' frontmatter `personas` (edge personas only) and every tester walks every journey: internal actors have no tester, and nothing ties a tester to the cards it should walk.

## The model

- **Persona** (`gherkin/persona`, ids `P-NNNN`): `name` (short, unique, the title prefix its cards use: "Operator", "CLI actor", "Driver Agent"), `kind` (`human` | `cli` | `agent`), `text` (one to three sentences a tester roleplays: who they are, how they reach zarg, what they can and cannot see).
- **By** (`gherkin/by`, card → persona): who acts in the card's When. A card has one or more `by` edges (a shared action names each actor). A card without one is on the agenda.
- Naming: humans by role ("the operator"); CLI callers are CLI actors; zarg's internal agents are "the X Agent" (Driver, Planner, Implementer; a Plugin Agent).

```json
{ "id": "P-0002", "type": "gherkin/persona", "edges": [],
  "props": { "name": "CLI actor", "kind": "cli",
    "text": "A coding agent (Claude Code, Codex) working through the zarg CLI and its skills: it reads JSON, retries on hints, never sees the TUI." } }

{ "id": "UX-0079", "type": "gherkin/card",
  "edges": [ { "to": "P-0002", "type": "gherkin/by" }, { "to": "S-0001", "type": "gherkin/arrives" }, { "to": "S-0091", "type": "gherkin/then" } ],
  "props": { "title": "CLI actor finds the affected cards", "when": "the CLI actor asks which cards changed since the last checkpoint" } }
```

Rendered:

```
UX-0079 CLI actor finds the affected cards
  By    CLI actor  # P-0002
  Given the CLI actor works in a repo with a zarg graph  # S-0001
  When  the CLI actor asks which cards changed since the last checkpoint
  Then  the affected cards are listed, removed ones apart  # S-0091
```

## Tools and checks (Gherkin plugin)

- `gherkin/add-persona {name, kind, text}`, `gherkin/edit-persona {id, name?, kind?, text?}`; `gherkin/remove` removes a persona no card names (refused while cards name it, listing them).
- `gherkin/add-card` takes `by: [{id} | {name}]` (at least one); `gherkin/link` / `unlink` take `edge: "by"` with a persona (`{id}` or `{name}`). Unlinking a card's last `by` is refused.
- Lints: a persona name is unique (case-insensitive) and at most 4 words; its text at most 60 words; `kind` is one of the three; a `by` edge points at a persona (not a state or card).
- Agenda: "Who does UX-NNNN?" for a card with no `by` (priority as dead ends), with the personas as the likely answers; "Nobody acts as P-NNNN" for a persona no card names (lower priority).
- `render` shows a `By` line (names, comma-separated); `show` of a persona lists its cards under `inbound`.
- `affected`: a persona's `text` change does not affect cards (it changes testers, not behaviour); a card's `by` change does.

## Rehearse

- Testers: one per persona that at least one card names (every kind, agents included), roleplaying its `text`. No decision-model screening, no intent parsing. `/rehearse` can still narrow to named personas.
- Stories: unchanged (edge-pair over all cards). A tester walks each story that has at least one card by its persona; it judges only those steps, and the other steps are its context ("what happened so far"), so the operator's tester sees the Driver Agent's question before answering it.
- Findings keep the persona that reported them (as now, by name).
- A graph without personas: rehearse refuses with "no personas yet: the Driver Agent asks about them" (today's intent fallback is removed once personas are in the graph).

## Who manages personas

The Driver Agent, with the operator; nothing is built in (zarg specifies any product, so no persona list ships with it).

- **A new project:** with no personas in the graph, the agenda asks "Who uses this product?". The Driver Agent drafts personas from the intents' frontmatter `personas` (the edges: who meets the product) and the conversation, and shows them with `Inquire.confirm` like any graph change; the operator accepts, edits or adds.
- **New cards:** `add-card` needs `by`. The Driver Agent names the persona while drafting the card; when none fits, it proposes a new persona in the same confirmation.
- **Existing cards without `by`:** one agenda item, "Who does these N cards?". The Driver Agent proposes the whole mapping (from each card's title and When) as one change; cards it cannot place it asks about one by one.
- **The intent names edge personas only** (who meets the product from outside). Personas for the product's own internal actors (in this repo: the Driver, Planner, Implementer and Plugin Agents) live only in the graph, where cards need them.
- **CLI actors** (the zarg-drive skill) follow the same rules through the same tools.
- No migration command: this repo's graph gets its personas the same way, through the Driver Agent (or zarg-drive), confirmed by the operator.

## Errors

- `add-card` without `by`: refused with a hint naming the personas.
- A `by` to a missing id or unknown name: refused with the known names.
- A persona removed while named: refused, listing the cards.
- A rehearse run with personas but no card naming one: refused ("no persona acts in any card").

## Testing

- Gherkin plugin: add, edit and remove personas (refusals included); cards with one and with two `by` edges; the `By` line in render; agenda items for a card without `by` and an unused persona; `affected` ignores persona text edits, counts `by` changes; lints for name, text and kind.
- Rehearse: testers come from personas (agents included, no screening); a tester judges only its persona's steps and sees the others as context; a card by two personas is judged by both testers; the no-personas refusal.
- Driver Agent: with no personas, its agenda asks who uses the product; a card without `by` yields one mapping item; a confirmed mapping links every card it names.

## Scope

In: the persona node and `by` edge, their tools, lints, agenda items and render; rehearse's testers from personas; the Driver Agent asking about personas (new projects, cards without `by`); the zarg-drive skill naming `by` on every new card.

Out: personas in the TUI (a persona filter on the review queue or the grid), per-persona settings for rehearse (budgets, models), personas for systems (git, model providers stay prose in the intent).
