---
author: the operator (with Claude)
date: 2026-09-26
revised: 2026-09-27
status: accepted
personas:
  - name: Operator
    kind: human
    text: the person shaping their product with zarg, through its terminal app or any client. They talk about intent, answer questions, approve what is written and what runs, and watch or stop the work.
  - name: CLI actor
    kind: cli
    text: a coding agent (Claude Code, Codex) working the same requirements and code through the zarg command line and its skills. It reads and writes structured output, follows refusals and hints, and never sees the terminal app.
next:
  - name: Providers and plugins in the app
    why: the operator sets up model providers and plugins in the terminal app (consent, settings, login), without editing files
  - name: Capture
    why: the agent keeps the intent documents from the conversation, so the operator never edits them by hand
  - name: Specify
    why: intents become requirements on their own, each traced to its intent
  - name: Rehearse by persona
    why: testers roleplay each persona over the journeys that persona acts in
  - name: Code ownership
    why: the operator sees which code each card owns
---
# Intent: zarg, a harness where you only talk about intent

## Problem

Building software with coding agents still means driving every step yourself: writing requirements, splitting work, prompting implementation, reviewing code, re-explaining context that got lost. The agent's memory is a stream of chat that grows until it is truncated, so decisions drift and work is redone. What the operator actually owns is the intent: what the product should do and why. Everything after that is mechanical enough to automate, but no harness separates the two.

## Personas

Who meets zarg at its edges; listed in the frontmatter (`personas`), where rehearse and zarg's agent read them. The requirements graph names who acts in each card; zarg's agent asks about personas when a project starts and keeps them there.

## Inputs

- The operator's words: what the product should do and why, answers to questions, interjections, approvals and refusals.
- The project's git repository: its code, its history, and anything the operator has changed while zarg works.
- Plugins the operator installs and grants: what they add to the requirements and the checks they report. Their output is always treated as untrusted.
- Models: local models and hosted providers the operator configures, with their keys.

## Outputs

- Intent documents (`intent/*.md`): what the product is for, in the operator's words.
- The requirements graph (`.zarg/graph`): the product as atomic user actions, each traceable to an intent.
- Feedback and plans (`.zarg/feedback`, `.zarg/triage`, `.zarg/backlog`): what testers found on each version of a card, how the operator triaged it, and the plans that change the requirements before anything is built.
- Plans and code, verified and landed on the operator's branch as commits, each traceable to its cards.
- Questions and findings for the operator: one at a time, with options and a recommendation.
- A live view of the work: what runs, what it decided, how far it got, what waits for the operator.

## Expected outcomes

- **One continuous conversation.** The operator talks to one agent, only about intent, and it picks up where they left off without replaying the chat. Nothing important lives only in a transcript.
- **The agent leads.** It asks one question at a time, always with options and a recommendation; the operator can answer something else or interject at any moment. With nothing to ask, it asks what is next, with options drawn from what is missing.
- **Everything after intent follows on its own.** Requirements, rehearsals by roleplaying testers, plans and code keep themselves in step with what the operator said. Whatever cannot follow comes back as a question.
- **Fast and cheap where it can be.** Small judgments use small, fast models; large models only write intents, requirements, plans and code. Local models come first.
- **Visible and interruptible.** Every agent's work shows live, and the operator can stop any of it.
- **Durable.** A restart resumes work instead of redoing it, and a pending question survives it.
- **Safe.** Secrets never reach a model, a log or the wire. Plugins run only with what the operator granted. Requirements change only with the operator's say; code changes only to match the requirements.

Success: the operator describes what they want, answers a few good questions, and working, verified, committed code follows, with every line traceable back through a card to an intent.

## Constraints

- Git is required. Work happens off to the side and lands on the operator's branch; only conflicts zarg cannot settle reach them.
- The operator's uncommitted edits are never overwritten.

## Open questions

- How an intent is accepted: an explicit yes from the operator, or implied once its requirements follow cleanly.
- Rehearse cost and cadence: how many testers, how often, and which findings reach the operator versus being applied automatically.
- Several conversations with different focuses: one agent with many threads, or one per focus.
