# What waits on the operator, in the inbox (spec 3 of 4)

Date: 2026-09-30 · Status: written by the implementer on the operator's behalf ("you're in charge")

## Outcome

Everything that sits waiting for the operator today, where work is skipped until they act, becomes a topic. So do the reports worth reading. Nothing waits unseen:
- a plan that can't apply;
- a feedback entry rehearse wants a product decision on;
- a card triage left out;
- a reconcile finding;
- a finished rehearse run;
- a triage round folded into plans.

## Sources

The backlog is the hub for feedback, rounds and plans, so it raises most topics: it gains `inbox: true` and an `answered` method. The core raises reconcile findings itself, as it does disabled plugins.

| Topic | From | Answers | Answer does | Settles when |
|---|---|---|---|---|
| `plan`: "B-12 can't apply: …" (a plan's `needs`) | backlog, key `needs:B-12` | Back to Ready · Drop | moves it to Ready (clearing `needs`) or drops it | the plan moves, or is dropped |
| `question`: "Keep this feedback on? UX-0044: …" (rehearse's "ask" route: a product decision) | backlog, key `ask:F-…` | Keep it on · Turn it off | sets the entry on or off, by the operator | the entry leaves open (planned, closed, stale), or the operator flips it in Feedback |
| `plan`: "UX-0044 left out of Set up's round" (a card that failed its tries) | backlog, key `left:<journey>:<card>` | Draft again · Leave it out | Draft again: the card waits for triage again (redo); Leave it out: nothing | the round moves on (planned, back to triage) |
| `finding`: "UX-0023 verify keeps failing" (reconcile) | zarg (core), key `finding:<id>` | none: zarg takes findings up (they stay first on its agenda); evidence is the detail | — | the finding clears |
| `report`: "Rehearse run r-12: 14 entries on Watch agents, Set up" | backlog, key `run:<run>` | none | read once opened | read |
| `report`: "Set up folded into 3 plans: B-14, B-15, B-16" | backlog, key `plans:<journey>:<ids>` | none | read once opened | read |

Each topic's `origin` is the backlog's Feedback or Backlog view, so `o` opens the place to act in full.

## Keeping them true

- **One sync step per source.** The backlog's `refresh` of its board and feedback, and the file and plan handlers, posts or settles its topics from its own state. Posting by key is idempotent (spec 1): an unchanged post logs nothing.
- **Answers:** a topic answered in the inbox runs the same code as the matching action in the Feedback or Backlog view, through `answered({ id, answer })`. An answer whose plan, entry or card has moved on meanwhile gets a notice and changes nothing.
- **Findings:** the core syncs finding topics after every reconcile pass result, and on start.
- **Load grant:** a new scope changes the backlog's grant digest, so the operator approves the backlog once more (YOLO loads it silently).

## Tests

For each row:
- the topic is posted with its answers;
- each answer does what the table says;
- it settles when its source moves on;
- a stale answer changes nothing.

Findings follow `syncPluginTopics`: post, settle when cleared.
