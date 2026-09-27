# Phase 2b-1: core process, driver loop and TUI

Date: 2026-09-26
Status: approved in conversation, pending written review
Parents: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md` (section 5), `docs/superpowers/specs/2026-09-25-agent-runtime-design.md` (2a)
Requirements served: UX-0008..UX-0015 (driver loop, what next), UX-0040..UX-0044 (visible agent work, stop) in `.zarg/graph`

## Intent

Turn the 2a runtime into something the developer talks to: a core process that runs driver threads on RLMs and speaks AG-UI, and an OpenTUI app that renders the conversation, inquiries and agent activity.

Phase 2b is split:

- **2b-1 (this spec):** core process, AG-UI server, threads, the driver loop, `@zarg/client`, the OpenTUI app.
- **2b-2:** the sync loop (graph commit stream and watcher, debounced sync RLMs, blocked cards back to the agenda; UX-0020..UX-0025).
- **2b-3:** provider login and model setup (UX-0026..UX-0039).

Phase 3 shrinks to plugin views (each plugin's client half).

## Packages

```
packages/
  core/    @zarg/core    zarg-core, one per project: builds the 2a runtime once (Env, Config, Model,
                         Decisions, GraphStore + PluginHost, Rlm), serves AG-UI, runs driver threads.
  client/  @zarg/client  AG-UI client over the unix socket and a pure reducer: events → ThreadState.
                         Never imports @zarg/core or any /server subpath.
  cli/     @zarg/cli     `zarg`: the OpenTUI app (@opentui/react), core lifecycle commands.
```

## Process model

- **Default: core is a child of the CLI.** `zarg` spawns `zarg-core` as a subprocess with the socket path and token on its command line; core prints `ready` on stdout. Core stops when the CLI exits. If the CLI crashes, core notices (parent pid gone, stdin pipe closed) and shuts down within seconds.
- **Optional: headless.** `zarg core start --headless` runs core detached until `zarg core stop`. For web or other AG-UI clients and for leaving agents running.
- **Attach rule.** `zarg` first reads `.zarg/run/core.json`; if it names a live core (headless or owned by another CLI), it attaches. Otherwise it spawns its own child core. A client attached to another CLI's child core reports "core stopped" when that core goes away.
- **One writer.** A core refuses to start while `core.json` names a live pid.
- `.zarg/run/core.json` (mode 0600): `{ pid, socket, token, mode: "child" | "headless", owner? }`. `.zarg/run/` is gitignored.

## Server

- HTTP over the unix socket `.zarg/run/core.sock`, Effect `HttpRouter` on `@effect/platform-bun`. Every request carries the token from `core.json` (`Authorization: Bearer <token>`); otherwise 401.
- `POST /runs`: an AG-UI `RunAgentInput` (`threadId`, `runId`, `messages`, optional `resume`). Response: an SSE stream of that run's AG-UI events.
- `GET /stream?since=<seq>`: every thread's events for reconnect and replay.
- `GET /threads`: `[{ id, focus, status }]`.
- `POST /threads/:id/stop`: stop the thread's current work (UX-0044).
- Every event payload passes through the leak guard's `redact()` before it is logged or sent.

## Threads

- A thread is `{ id, focus? }`. `main` always exists and covers the whole graph. `zarg --thread checkout --focus S-0002` creates or attaches a focused thread; the focus narrows the agenda and the driver's graph scope.
- Each event is appended to `.zarg/threads/<id>.jsonl` with a sequence number. `/stream?since=` replays from it.
- Proposing a focus by inquiry and conflicts between threads (UX-0016..UX-0019) are out of scope here.

## The driver loop

One fresh `driver` RLM per agenda item. Continuity lives in the graph and in the thread's short summaries.

```
loop per thread:
  item = agenda(focus).first ?? "The agenda is empty: ask the developer what to work on next, with options drawn from the graph."
  outcome = Rlm.exec({ preset: "driver", task: item + the last few thread summaries, scope: { graph: focus } })
  append outcome.value (the driver's summary, preset result "text") to the thread as an assistant message
  repeat
```

- The driver RLM asks with `yield* Inquire.ask(...)`. `Inquire`'s host implementation parks the cell and ends the current AG-UI run with an interrupt (below). The loop continues when the next run resumes it.
- **Nothing is written that the developer did not see.** Graph writes open only when the developer adds a change shown with `Inquire.confirm({ change })` (each card as Given / When / Then, with Add it / Change it / Skip), or the driver adds a discussed one for them with `Inquire.choose`. The next question closes writes again.
- **What next is the developer's to say.** With an empty agenda:
  - Gaps found: the driver asks once from them, with "Something else…" for the developer's own idea; it never makes up a journey. After that round the loop waits for the developer (the run ends) instead of asking again. Gaps are failure candidates for steps with only one way on, kept only when the decision model finds a failure likely (probability ≥ 0.75, one card per request); most such steps cannot fail, so usually none are kept.
  - No gaps: zarg asks itself, with no driver turn: "Nothing is open in the requirements. What do you want to work on?", offering the intent's next goals (the numbered list under `Next:` in `intent/*.md`, first recommended; the journeys' entry states when there is no intent) and "Something else…". The answer goes to the driver as the developer's word.
- The driver spawns only `research` children; it never spawns another driver.
- A failing RLM (`RlmError`) ends the run with `RUN_ERROR`; the thread stays usable and the next run starts the loop again.
- `POST /threads/:id/stop` interrupts the thread's loop fiber, which interrupts the running RLM and its children (kernel interrupts reach host calls). The stop is noted in the thread (UX-0044).

## Runs, inquiries and interjections

- **A run** is one stretch of a thread's loop: from start or resume until the next inquiry (`RUN_FINISHED{outcome: {type: "interrupt", interrupts: [inquiry]}}`) or an error (`RUN_ERROR`). The first run on a thread starts its loop.
- **Inquiry → interrupt.** `interrupts: [{ id, reason: "inquiry", message: question, metadata: { options, allowOther, about }, responseSchema }]`.
- **Resume.** A run with `resume: [{ interruptId, status: "resolved", payload: { choice } | { other } }]` settles the parked `Inquire.ask`; the same cell continues.
- **Interjection (UX-0012, UX-0013).** A run with a new user message while an inquiry is pending answers the pending ask with `{ other: message, interjected: true }`. The driver sees the developer's message in place of an option. The dropped question is recorded in the thread.
- **After a core restart** a parked ask is gone. The thread starts again from the agenda; an answer for an unknown interrupt is treated as a user message (logged).

## Events

- `RUN_STARTED`, `RUN_FINISHED` (success or interrupt), `RUN_ERROR` (with the error kind and message).
- `TEXT_MESSAGE_START` / `_CONTENT` / `_END`: the driver's summary after each agenda item, and the developer's messages echoed.
- `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA`, `activityType: "zarg.rlm"`: the RLM tree. Each node: `id`, `parent`, `preset`, `scope`, `turns`/`budget`, `status` (`running` | `done` | `failed` | `stopped`), and decisions with confidence (UX-0040..UX-0043). The RLM runtime's `rlm.start`, `rlm.end`, `rlm.atomize`, `rlm.plan`, `rlm.child` and decision logs become these deltas.
- Every event core emits validates against `@ag-ui/core` 1.0's schemas (tested).

## Client and TUI

- `@zarg/client`: connects to the unix socket with the token, posts runs, reads SSE, reconnects with `since`. A pure reducer turns events into `ThreadState { messages, pendingInquiry?, rlms: tree, status, error? }`.
- `zarg [--thread <id>] [--focus <node>…]` opens the OpenTUI app (`@opentui/react`):
  - **Conversation pane:** the developer's and the driver's messages.
  - **Inquiry picker** inline: arrow keys; the recommended option is preselected with its `why` shown; the last row "Something else…" opens a text field; Enter answers.
  - **Input line:** typing while the driver works sends an interjection.
  - **Agents pane:** the live RLM tree: preset, id, turns/budget, status, and decisions with confidence under the RLM that made them.
  - **Status line:** thread, driver model, core mode.
  - **Keys:** `Ctrl-C` once stops the thread's current work; `Ctrl-C` twice or `Ctrl-D` exits (stopping a child core). `Tab` switches focus between conversation and agents.
- Structure: the reducer in `@zarg/client`; a pure view model in `@zarg/cli`'s `tui/` (ThreadState → rows, picker, tree); thin React components. A boundary test forbids the TUI from importing `@zarg/core` or any `/server` subpath.

## Errors

- Core fails to start: the CLI shows core's stderr; it never hangs waiting.
- A run fails: the conversation shows the `RUN_ERROR` kind and message; the thread stays usable.
- Missing or wrong token: 401. A second core for the same project refuses to start.
- Secrets never reach the wire: event payloads are redacted before they are written or sent.

## Testing

No real model in `mise run verify`.

- **Thread loop:** stub model and stub `Decisions` driving `Inquire`: the first run ends with an interrupt; resume continues the same cell; an interjection answers the pending ask; an empty agenda produces the "what next?" inquiry; stop interrupts the running RLM.
- **HTTP:** in-process via `toWebHandler`: token checks, SSE framing of `/runs`, `/stream?since=` replay from the JSONL log.
- **Wire contract:** every emitted event validates against `@ag-ui/core` 1.0.
- **Reducer:** scripted event sequences → expected `ThreadState`.
- **TUI:** view-model unit tests (picker with the recommended option preselected, the free-text row, interjection, the RLM tree from activity deltas); a few frame snapshots with OpenTUI's test renderer (an inquiry, the agents pane, a `RUN_ERROR`); one end-to-end test of the TUI against a child core on the stub model (selected by a test-only environment flag) that answers an inquiry by key presses; exiting stops the child core.
- **Live** (outside `verify`): `mise run smoke:chat` runs one real driver item on the configured driver model with a scripted answer.

## Out of scope

- The sync loop (2b-2), login and model setup (2b-3).
- Focus proposals and cross-thread conflicts (UX-0016..UX-0019).
- Plugin state projection over `STATE_*` events and plugin client views (phase 3).
- Remote/TCP transport.
