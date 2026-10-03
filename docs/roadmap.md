# zarg roadmap and internals

How zarg is built and where it is going. The product intent (its outcomes, constraints and questions) is intent I-0001 in the graph (`zarg render --focus I-0001`); this file holds what the intent deliberately leaves out.

## Phases

Each phase reads an upstream artifact, diffs it against what it projected last time, and updates its downstream artifact until a gate passes (the reconcile loop). A small choice model (Decisions: yes/no, choice, score with confidence) makes the frequent small judgments.

| Phase | Upstream to downstream | Runs |
|---|---|---|
| capture | conversation to intent artifacts (`intent/*.md`) | the intent agent, with you |
| specify | intents to atomic features (the Gherkin user action graph) | automatically, after quiet |
| rehearse | features to refined features: testers roleplay the flows | in the background, continuously |
| plan | features to a plan per change | automatically, after quiet |
| implement | plan to code, in git worktrees, verified, landed as commits | automatically, after quiet |

## Internal constraints

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

## Open questions (internal)

- The plan artifact: one committed plan file per card (`.zarg/plans/<card>.md`); its exact format is set in the 2b-2 spec.
- How much of each phase the choice model can decide alone before a large model is needed.
