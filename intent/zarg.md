# Intent: zarg, a harness where you only talk about intent

- Author: developer (with Claude)
- Date: 2026-09-26
- Status: accepted (2026-09-26)

## Problem

Building software with coding agents still means driving every step yourself: writing requirements, splitting work, prompting implementation, reviewing code, re-explaining context that got lost. The agent's memory is a stream of chat that grows until it is truncated, so decisions drift and work is redone. What the developer actually owns is the intent: what the product should do and why. Everything after that is mechanical enough to automate, but no harness separates the two.

## Proposed outcome

You talk to one agent, the **intent agent**, and only about intent. Everything downstream is automation that keeps itself in step with what you said.

- **One continuous conversation, not a context stream.** The intent agent is always there and picks up where you left off, but it never replays the chat to remember. Its context is rebuilt each turn from the intent artifacts, the feature graph, its agenda and a short recent summary. Nothing important lives only in the transcript.
- **The agent leads.** It asks one question at a time, always with options and a recommendation, and you can answer something else or interject at any moment. When it has nothing to ask, it asks what is next, with options drawn from the artifacts.
- **Everything downstream is a projection.** Each phase reads an upstream artifact, diffs it against what it projected last time, and updates its downstream artifact until a gate passes. The same **reconcile** loop runs every phase. Whatever a phase cannot project goes back upstream as a finding, and reaches you as a question from the intent agent.

| Phase | Upstream to downstream | Runs |
|---|---|---|
| capture | conversation to intent artifacts (`intent/*.md`) | the intent agent, with you |
| specify | intents to atomic features (the Gherkin user action graph) | automatically, after quiet |
| rehearse | features to refined features: testers roleplay the flows | in the background, continuously |
| plan | features to a plan per change | automatically, after quiet |
| implement | plan to code, in git worktrees, verified, landed as commits | automatically, after quiet |

- **Fast and cheap where it can be.** A small choice model (JEV-style Decisions: yes/no, choice, score with confidence) makes the frequent small judgments: what a change affects, whether work is atomic, triaging and deduping findings, scoring rehearsal steps. Large models only write intents, cards, plans and code. Local models through zarg-router come first.
- **Visible and interruptible.** Every agent's work shows live (the RLM tree, budgets, decisions with confidence), and you can stop any of it.
- **Durable.** Passes run as durable workflows: a restart resumes them from the last finished step instead of redoing work, and a pending question survives a restart. Zarg scales past one process when remote models (OpenRouter) make local CPU the limit.

Success: you describe what you want, answer a few good questions, and working, verified, committed code follows, with every line traceable back through a card to an intent.

## Affected users and systems

- The developer, through the zarg TUI (and any AG-UI client).
- The project's git repository: intents, the feature graph (`.zarg/graph`) and code share one history. Each implement pass lands one commit containing the cards, their plans and their code.
- Model providers: zarg-router (local models, the choice model) and OpenRouter.

## Constraints

- Git is required. Downstream work happens in git worktrees and lands on your branch automatically; only conflicts it cannot settle reach you.
- Agents never cross their layer: the intent agent changes intents (and, until specify exists, the graph), never code; implement changes code, never requirements.
- The RLM is the unit of agency: every agent run is an RLM with a scoped layer and budget, and RLMs call RLMs to fold context. The kernel exists for folding, not isolation.
- Plugins decide what goes on the graph. The core is headless and speaks AG-UI; clients are separate.
- Secrets never reach a model, a log or the wire (varlock, redaction).
- Stack: mise, bun, TypeScript, Effect 4 (services and layers), OpenTUI. Durability and scale-out use Effect's cluster and workflow modules (`effect/unstable/*`) on `bun:sqlite`; unstable APIs are accepted and refactored as they change.
- Every side effect in a durable pass is an idempotent step, since an interrupted step runs again.

## Current goals

Done:
- The feature graph, plugins and the Gherkin plugin, with the `zarg` CLI and Claude Code skills (phase 1).
- Models, Decisions, the kernel and the RLM with folding (phase 2a).
- The core process with AG-UI, driver threads with inquiries, the client and the OpenTUI app (phase 2b-1). The driver there is the first form of the intent agent.
- Plan and implement on the generic reconcile loop, each pass a durable workflow (phase 2b-2).
- The plugin runtime and SDK: every plugin runs in its own locked-down process with only the scopes you granted, and Gherkin is the first plugin on it.

Next:
1. **Plugins, continued**: providers become plugins (zarg-router's warm and decisions as its own methods), agents call plugin methods you grant them (plugin output always marked untrusted), and a TUI for consent, config and login by archetype (replacing `/models`).
2. **Capture**: the driver becomes the intent agent and keeps `intent/*.md`; its context comes from artifacts, never the transcript; pending questions become durable.
3. **Specify**: intents projected to cards, with each card tracing to its intent.
4. **Rehearse**: roleplay testers over the graph (ported from Colony's flow tester: edge-pair walks, typed findings, step scores).
5. Implement code ownership (tagged regions, generated output or a hybrid).

## Open questions

- The plan artifact: one committed plan file per card (`.zarg/plans/<card>.md`); its exact format is set in the 2b-2 spec.
- How an intent is accepted: an explicit yes from you, or implied once specify projects it cleanly.
- Rehearse cost and cadence: how many testers, how often, and which findings reach you versus being applied automatically.
- Several threads with different focuses: one intent agent with many threads, or one per focus.
- How much of each phase the choice model can decide alone before a large model is needed.
