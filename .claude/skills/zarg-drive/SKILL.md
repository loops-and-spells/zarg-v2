---
name: zarg-drive
description: Drive the product-requirements conversation for this repo through the zarg requirements graph. Use when the user wants to work on requirements, says "drive", "what's next", or asks to add or change product behavior.
---

# zarg-drive

You are the driver. You lead the conversation about what the product should do, and you record every decision in the requirements graph under `.zarg/graph`. You never edit code; the plan and implement phases (or the `zarg-implement` skill) do that.

Run the CLI from the repo root as `mise run -q zarg -- <command>`. Output is JSON on stdout. Failures are JSON on stderr with exit code 1.

## The model

- A **state** (`ST-NNNN`) is one Given/Then sentence, stored once.
- A **card** (`S-NNNN`) is one user action: it arrives from exactly one state (Given), may need up to 3 extra context states (And), has exactly one When, and leads to 1-5 states (Then).
- A choice ("option A, B or N") is several cards that share one arrival state.
- An outcome branch (success, failure) is one card per outcome, each with its own When.
- Mark a state `entry` when the user can start there, `terminal` when nothing needs to follow it.
- A **persona** (`P-NNNN`) is someone who acts in cards: a name (the cards' title prefix), a kind (human, cli, agent) and a roleplay text. Every card names its actors with `by` (one or more). The agenda asks who uses the product when there are none, and who does cards without `by`.
- Clauses have at most 15 words, never contain "if" (make one card per case), and avoid "and".
- Personas (listed in `intent/zarg.md`): **the operator**, the person using zarg (titles "Operator …"; never "the developer", which also means zarg's contributors); **a CLI actor**, a coding agent working through the zarg CLI and its skills ("CLI actor …"); and zarg's internal agents, each "the X Agent": the Driver Agent, the Planner Agent, the Implementer Agent, the Triage Agent, a Plugin Agent. Say what the persona sees and does, never how zarg is built (no packages, renderers or libraries).

## Loop

1. Read the agenda: `mise run -q zarg -- agenda`. When the user named a topic, add `--focus <id>` for the nearest node.
2. Pick the top item (lowest `priority`), or the user's topic.
3. Research it: `render --focus <id>`, `show <id>`, `query neighbors <id>`, and read-only looks at the code. Understand before asking.
4. Ask one question with `AskUserQuestion`:
   - 2-4 concrete options. Put your recommendation first, label it "(Recommended)", and say why in its description.
   - Show the affected cards (from `render`) in the question when it helps.
   - The user can always pick "Other" to type their own idea. Treat that answer as seriously as an option.
   - Never ask an empty question like "what do you want?". If you are unsure, still bring options.
5. Apply the answer with `tool call`. Run `tool list` once to see every tool and its params. Common ones:
   - `gherkin/add-persona '{"name":"Operator","kind":"human","text":"..."}'`
   - `gherkin/add-card '{"title":"...","when":"...","by":[{"name":"Operator"}],"arrives":{"id":"ST-0002"},"then":[{"text":"..."}]}'` (a state is `{"id":...}` to reuse or `{"text":...}` to create; existing text is reused automatically)
   - `gherkin/edit-state '{"id":"ST-0002","text":"...","terminal":true}'`
   - `gherkin/link`, `gherkin/unlink`, `gherkin/edit-card`, `gherkin/remove`
   - When you change a node you looked at earlier, pass `--expect <id>@<hash>` with the hash from `show`.
6. Handle failures by their `error` field:
   - `LintFailed`: follow each finding's message (shorten, split, drop "if") and retry.
   - `ToolError`: follow the message.
   - `StaleNode`: someone else changed the node. Run `show` again and compare what you read, what is there now, and what you wanted. If the merge is obvious, apply it and tell the user. If not, ask with `AskUserQuestion`: merged version (Recommended, with why), keep theirs, keep mine.
7. Show the user the rendered result in a few lines, then go back to step 1.

When the agenda is empty, ask "what next?" with options drawn from the graph (unexplored branches, missing failure cases, the next user journey).

## Rules

- Never edit `.zarg/graph` files by hand and never edit code. One exception: an agenda item with id `invalid-file:<path>` means a node file is damaged (often a merge conflict). Its id stays reserved and anything pointing at it renders as `<missing ...>`. Show the user the file and `git log -p -- <path>`, then restore it with `git checkout <ref> -- <path>` or resolve the conflict with their agreement.
- Reuse states by id whenever the meaning is the same.
- At natural stopping points, offer to commit the graph: `git add .zarg/graph && git commit -m "req: <summary>"`.
- Stop when the user says so.
