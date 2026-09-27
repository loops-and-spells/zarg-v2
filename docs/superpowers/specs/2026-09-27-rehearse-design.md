# Rehearse: testers roleplay the journeys, the driver triages

> Moved into `@zarg/plugin-rehearse`; the developer picks which findings to apply. See `docs/superpowers/specs/2026-09-27-service-plugins-rehearse-design.md`.

Date: 2026-09-27
Status: design approved in conversation, pending written review
Intent: `intent/zarg.md` (the rehearse phase: "features to refined features: testers roleplay the flows"; Next goal 4)
Scope: stage 1, rehearsing the spec (the Gherkin graph). Stage 2, testers driving the running product on VMs, gets its own spec after the VM plugin is ported from `~/Git/zarg`.

## Outcome

The developer (or the driver, when it judges the graph ready) starts a rehearsal. Testers, one per affected user in the intent, walk every journey in the graph and report where it breaks, confuses or surprises. The driver turns those findings into graph changes: clear fixes land on their own, product decisions come to the developer. Graph changes then flow downstream to plan and implement like any other.

- Fast: a small decision model screens every step; a large model only looks at the steps that look wrong, and writes one report per run.
- Rehearse only reports. It never writes the graph, and nothing in this design touches intent.

## Background

Ported from Colony's flow tester (`~/Git/colony`, `packages/server/src/flow-tester.ts`, `docs/research/2026-08-05-flow-coverage-criterion.md`), keeping its lessons:

- Edge-pair coverage (Ammann and Offutt): stories cover every step and every consecutive pair of steps. On Colony's 22-card graph that was 14 stories and 116 visits per tester, against 151 stories and 654 visits for every full path, with no dropped branches.
- Typed findings (friction, gap, contradiction, transition, feature, delight) with a severity and a suggested change.
- Model or transport failures never become findings ("the planner fixes ghosts"); they are one infrastructure note.
- Stable finding ids, so reruns merge instead of multiplying.
- A lint counts as fixed only when a re-check clears it.
- Findings applied in bulk grew cards into walls; oversize cards are split, never grown.

Colony differs in two ways this design changes: every step there was a large-model call, and its ok/partial/fail grade was a word-overlap proxy, never model-graded.

## Calibration (measured 2026-09-27, jevk5)

14 labelled web-shop steps, one first-time-buyer persona, six questions per step. Asking the questions together or one at a time gave identical answers (the decision model scores each question on its own), at a median 133 ms per step.

| question | separates good from bad | evidence |
|---|---|---|
| `feel` (score: blocked, confusing, fine, pleasing) | yes, as a general anomaly signal | problem steps 0.69 to 1.42; good steps 1.60 to 1.88 |
| `fail` (can this go wrong in a way I must handle?) | yes | missing failure cases p 0.85 and 0.88; steps that cannot fail 0.40 and 0.43; one false positive (0.83) |
| `choose` (at a fork, which would I pick?) | yes | clear fork 0.96 / 0.04; ambiguous fork 0.69 / 0.31 |
| `arrive` (is the Given true after how I got here?) | weakly | broken seams 0.16 and 0.24; one good step 0.34 |
| `act` (would I know what to do?) | no | "does the usual thing" 0.70 against "clicks Checkout" 0.74 |
| `expect` (which outcome do I expect?) | no | "Save deletes the account" still chose the listed outcome (0.54) |

With the thresholds below, the flags caught 12 of 13 labelled cases and flagged no good step. The set is small and the thresholds are fitted to it: they are settings, the set is kept as a calibration check, and it grows from real runs (see Testing).

The decision model's `confidence` is `1 - normalized entropy`, so a yes/no at p = 0.82 only reaches 0.32; the thresholds use probabilities and scores.

## Using it

- **`Rehearse.run`**, a service in the driver's layer: `Rehearse.run({ strategy?, focus?, personas? })`.
  - `strategy`: `"edge-pair"` (default) or `"teleport"` (each card once, alone: a quick check; its diagnosis never reports seams, which it cannot see).
  - `focus`: card or state ids; only stories through them.
  - `personas`: names from the intent's affected users; all by default.
  - Returns at once with `{ run, stories, steps, personas }`. The run continues in the background.
- **`/rehearse [edge-pair|teleport] [id…]`** does the same from the TUI and says what started.
- One run at a time per project: a second is refused with "run R is still going".
- Testers, diagnosis calls and the report show in the agents pane; each has its history view.

## Personas

- One tester per bullet under "Affected users and systems" in `intent/*.md`, taken as written ("The developer, through the zarg TUI (and any AG-UI client)").
- A persona changes only through the intent.
- Testers never coordinate: each walks every story on its own.

## The run

A run is a durable workflow in the core, like a reconcile pass: a restart resumes it from the last finished step.

1. **Plan.** The Gherkin plugin gains two plugin methods:
   - `stories({ strategy, focus })`: the edge-pair stories as a trie (a greedy set cover of every step and consecutive step pair, root to leaf, loopbacks left out). Requirements no root reaches come back as one note.
   - `step({ card, via })`: what a tester sees at a step: the Given, When and Thens, the step it arrived by, and the outgoing steps at a fork.
   Other graph plugins can offer their own stories; rehearse does not know Gherkin.
2. **Screen.** One decision-model request per persona and step, 8 in flight. The state holds the persona, the story so far (the last three steps) and the card. Questions: `feel`, `fail`, `arrive`, and `choose` at a fork. A step is flagged when:
   - `feel` < `feel_below` (1.45),
   - `fail` p ≥ `fail_at` (0.8) and the card has no failure case,
   - `choose` top probability < `fork_below` (0.8),
   - or `arrive` p < `seam_below` (0.3).
   Stories run in parallel; within a story, steps run in order (the story so far is the context).
3. **Diagnose.** Each flagged step goes to a large-model tester (role `rehearse`): the persona, the story so far, the card and which screen answers flagged it. It returns up to 5 findings: `{ kind, card, edge?, severity, note, op? }`, with `kind` one of friction, gap, contradiction, transition, feature, delight. An answer that does not parse becomes one low friction finding. A model or transport failure is recorded as an infrastructure note, never as a finding.
4. **Consolidate.** Findings with the same kind and anchor whose notes overlap strongly collapse into one (the strongest severity wins, "reported N×" is kept). Each gets a stable id `R-<hash(kind, card, edge)>`, so a rerun updates it instead of adding another. One large-model report per run summarises what the testers met, in a few sentences for the driver.
5. **Record.** `.zarg/rehearse/<run>.json` (gitignored): the stories, every screen answer, the flags, the findings, the report and the infrastructure notes. Step scores are keyed by a hash of the card's text, so editing a card retires its old scores.

## Triage: the driver

- A finished run becomes one agenda item, "Rehearse run R: N findings", which wakes a thread paused on what next.
- For each finding, one decision-model request (the card and the finding):
  - `real`: keep at p ≥ 0.75, drop at p ≤ 0.25, ask the developer in between.
  - `route`: a local fix, a product decision, a removal of something already built, or noise.
- **Local fixes the driver applies without asking.** Edits backed by a finding open the graph write gate for that finding's cards; the driver's own ideas still need `Inquire.confirm`.
  - The fixer first checks that the finding still holds on the current graph.
  - A lint-type finding counts as fixed only when the lint no longer reports it.
  - An oversize card is split, never grown.
  - One commit per triage: `req: rehearse R: applied R-3a1f, R-77c2, …`, so a triage is one `git revert`.
- **Product decisions, removals of built cards, and contradictions** go to the developer as `Inquire.confirm`, with the finding as the reason.
- `feature` findings become proposals the driver can raise; `delight` findings are kept as notes (a later edit should not remove what testers liked).
- The driver's reply is one line: "Applied 5 rehearse findings; 2 need you."
- Graph commits flow downstream to plan and implement as usual.

## Settings

```toml
[rehearse]
feel_below = 1.45
fail_at = 0.8
fork_below = 0.8
seam_below = 0.3
real_keep = 0.75
real_drop = 0.25
in_flight = 8

[roles]
rehearse = "…"   # the diagnosis and report model
```

## Errors and safety

- Rehearse writes only `.zarg/rehearse/`. Graph changes come only from the driver's triage.
- Findings never cite secrets: every record is redacted like a transcript.
- A decision-model outage leaves steps unscreened: the run reports how many, and those steps are not diagnosed (a run never falls back to a large model per step without the developer asking).
- Stop (`Ctrl-C`, `/stop`) interrupts a run; its partial record is kept and marked stopped.

## Testing

No live model in `verify`: scripted Decisions and the stub model everywhere.

- **Stories:** on fixture graphs, edge-pair covers every step and step pair; shared prefixes are walked once; unreachable requirements become one note; teleport visits each card once.
- **Screen:** scripted answers produce exactly the flags the thresholds say; a decision-model failure is reported as unscreened steps.
- **Diagnose:** a flagged step yields typed findings; prose becomes one low friction; a model error becomes an infrastructure note, never a finding.
- **Consolidate:** duplicates collapse with their count; a rerun keeps the same ids.
- **Triage:** a finding-backed local fix is written without a question and lands in one commit naming its ids; a product decision asks with `Inquire.confirm`; a stale finding is dropped; intent files are never touched.
- **Service and command:** `Rehearse.run` and `/rehearse` return at once; a second run is refused; stop keeps the partial record.
- **Calibration:** the labelled set lives in the repo; `mise run calibrate:rehearse` runs it against the live decision model (asks first, like the smoke runs) and fails when any threshold misses more than one labelled case. An LLM finding on a step the screen did not flag is added to the set as a labelled case.

## Out of scope

- Stage 2: testers driving the running product (VMs, browser), after the VM plugin port.
- Random-walk strategies (Colony's drunken and drunk-chain) and batched steps.
- Colony's UI layout tournament (compose).
- Running rehearse on its own schedule; it runs when asked or when the driver calls it.

## Decided

- **Rehearse reports; the driver triages.** Findings reach the graph only through the driver.
- **Decision model first, large model on flagged steps and for the report**, from the calibration above.
- **Personas from the intent's affected users.**
- **Started by the driver or the developer**, never on a schedule; it runs in the background.
- **Walk strategies belong to the graph plugin**; the core runs the testers.
