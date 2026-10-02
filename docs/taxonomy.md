# zarg's taxonomy

One word, one meaning, across the graph, the agents, the views and the docs. When code, a view or a spec needs a term for one of these, it uses this one. `docs/gherkin-graph-spec.md` defines the requirements layer in full; this page places it among the rest.

## The layers

```
why        Intent ── has ──▶ Outcome · Constraint · Question             (what the product is for)
             │ for                ▲ serves      │ bounds
             ▼                    │             ▼
who/what   Persona ◀── by ── Scenario ── in ──▶ Journey                (what the product does)
                               │ arrives / given / then
                               ▼
                             State
how        Code ── @scenario tag ──▶ Scenario                           (how it is built)
work       Feedback entry · Plan · Finding                              (what changes next)
operator   Topic (in the inbox) · Decision · Report                     (what needs a person)
```

## Graph nodes (`.zarg/graph`, changed only through `zarg tool call`)

| Kind | Id | One | Rules |
|---|---|---|---|
| **Intent** | `I-0001` | what one product (or one area of it) is for: a title, the **problem** (prose, context only), a status (draft, accepted) | the problem is not traced; its statements are |
| **Outcome** | `O-0001` | one result the intent wants for its users ("the agent asks one question at a time, with options") | a statement |
| **Constraint** | `K-0001` | one rule that must hold wherever it applies ("secrets never reach a model, a log or the wire") | a statement |
| **Question** | `Q-0001` | one thing the intent has not decided yet; open until answered | a statement |
| **Persona** | `P-0001` | an actor role and how it reaches the product (human, cli, agent) | a name and a roleplay text |
| **Journey** | `J-0001` | a named set of scenarios for one recognizable activity; membership, not order | a name |
| **Scenario** | `S-0001` | one user action in one case: arrives from a state, When, Then states | the scenario rules below |
| **State** | `ST-0001` | one observable fact, stored once, shared by the scenarios that use it | one sentence |

**Statements** are the intent's pieces: outcomes, constraints and questions.

## Edges

| Edge | From → to | Says |
|---|---|---|
| `has` | intent → outcome, constraint, question | the statement belongs to this intent (exactly one) |
| `for` | intent → persona | the users this intent is for |
| `serves` | journey → outcome | the journey delivers this outcome (many to many) |
| `bounds` | constraint → journey or scenario | the rule applies here |
| `by` | scenario → persona | who acts in the scenario |
| `in` | scenario → journey | the scenario belongs to the journey (any number) |
| `arrives` / `given` / `then` | scenario → state | where it starts, extra context, what follows |

## Atomic: a rule, not a kind

A node is **atomic** when it says one thing in one sentence: at most 15–20 words, no "if" (one node per case), no "and" joining two ideas. Scenarios, states and statements are all atomic. That is what lets a change to one of them affect only what depends on it.

- **Scenario rules:** one arrival, at most 3 context states, one When, 1–5 Then states.
- **A scenario's Then** is the facts expected after its action: its Then states. An outcome is the intent's, never a scenario's.

## Gherkin's words

zarg's graph is Gherkin, stored as a graph. Gherkin's words map onto it like this:

| Gherkin | zarg | Difference |
|---|---|---|
| **Step** (a `Given`, `When` or `Then` line) | a scenario's line: its Given and Then lines are **states**, its When a field of the scenario | a state's text is stored once and shared: rewording it changes every scenario that uses it |
| **Scenario** (the steps that test one behaviour) | a **scenario** | exactly one When (atomic); a sequence of scenarios is a **story** |
| **Feature** (the scenarios for one capability) | a **journey** | membership, not order; rendered as `Feature:` |

## Versions

- **Node revision:** the hash of one stored node (stale-edit detection: `--expect id@hash`).
- **Content version:** the hash of a scenario, or a statement, with the wording it depends on. Feedback and plans pin it; when it changes, they are stale.

## Derived (computed from the graph, never stored as nodes)

| Term | Meaning |
|---|---|
| **Flow** | which scenario can follow which: through the states they share |
| **Story** | an ordered path of scenarios picked for rehearsal (journey, edge-pair, teleport) |
| **Coverage** | for an outcome: the journeys that serve it; "uncovered" when none |
| **Agenda** | questions the graph raises about itself: dead ends, scenarios without `by`, uncovered outcomes, journeys serving nothing, open questions |
| **Draft** | proposed tool calls evaluated over a snapshot without changing the graph |

## Code (in the repo, not the graph)

| Term | Meaning |
|---|---|
| **Tag** | a `// @scenario <id>` comment on the code that implements a scenario (and its test) |
| **Built** / **planned** | a scenario is built when its code is tagged; `planned` (a scenario field) when it is not built yet |
| **Audit** | `zarg audit`: every scenario tagged or planned, no tag naming a missing scenario (`untagged`, `planned-but-tagged`, `orphan`); every outcome served, every journey serving one (`uncovered`, `unserving`) |

## Work (files under `.zarg/`, the work on the graph)

| Term | Meaning |
|---|---|
| **Feedback entry** | `F-…`: one report on one version of one scenario (from a tester or the operator): kind, severity, note, on/off for triage |
| **Kind** (of feedback) | friction, gap, contradiction, transition, feature, delight, **drift** (the scenario and its code differ) |
| **Round** | one triage pass over a journey's feedback that is on (Refine): proposals drafted scenario by scenario, dry-run, folded into plans |
| **Plan** | `B-…`: a set of graph changes (or, for a **code plan**, a code change) in the Backlog's lanes: Backlog, Ready, Running, Review, Done; it may wait on other plans (`after`) |
| **Finding** | a reconcile pass's problem (unplannable, blocked scenario, merge conflict, verify failing, landing blocked, pass error) |
| **Pass** | one reconcile run: plan and implement the affected scenarios, verify, land one commit |

## The operator (the inbox)

| Term | Meaning |
|---|---|
| **Topic** | `T-…`: one thing that wants the operator: a grant, a question from zarg, a decision, a finding, a report; it carries evidence and messages |
| **Decision** | a topic's answers, when it has them (a number answers, `t` adds a reason) |
| **Blocking** | a caller waits for the answer (grants, zarg's questions) |
| **Report** | a topic with nothing to answer: read once opened |
| **Moot** | a topic that stopped mattering, with the reason |

## Agents

| Agent | Does |
|---|---|
| **zarg** (the Driver Agent) | the conversation: asks one question at a time, writes the graph with the operator's yes |
| **rehearse** (testers) | roleplay personas over stories of built scenarios; file feedback |
| **triage** | rounds: feedback into plans |
| **intent** | rounds: changed or uncovered statements into plans for journeys and scenarios |
| **Planner** | applies Ready plans to the graph |
| **reconcile** (Planner Agent, Implementer Agent) | passes: scenarios into code |

## Words to avoid

- **"Atom"** as a noun: say scenario, state or statement. "Atomic" is the rule.
- **"Card"** for a scenario (its old name). A card is an agent's tile in the grid, or a plan on the Backlog's kanban.
- **"Goal"** for an outcome (its old name).
- **"Outcome"** for a scenario's Then: an outcome is the intent's.
- **"Step"** for a scenario: a step is one Given, When or Then line.
- **"Thread"** for an inbox item: a thread is a core run thread (`main`, `plan`, `implement`); the inbox holds topics.
- **"Developer"** for the person using zarg: they are the operator.
