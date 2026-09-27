# Procedure memory: record, classify, recall, compile, improve

Date: 2026-09-27
Status: architecture approved in conversation, pending written review
Intent: `intent/zarg.md` ("Fast and cheap where it can be": the choice model makes the frequent small judgments; large models only where needed)
Scope: the whole architecture, in four phases. Each phase gets its own implementation plan; phase 1 is built first.

## Outcome

zarg stops generating the same code twice. Agents keep solving new problems by writing cells, but work that recurs is recognised, compiled once into a tested procedure, recalled by a fast classification, and improved over time by replaying what already happened.

- A task that matches a known problem class starts with that class's procedures available as ordinary typed calls.
- Every procedure is backed by recorded cases and only replaces generated code after it passes all of them.
- Model calls made from cells get their prompt and model from a role the decision model picks, not from the generated code.
- The loop runs off the critical path: learning never slows down an agent's turn.

## Background

- **Dream-RSI** (Zheng et al., 2026, arXiv 2609.14858): logs every run as a discovery tree and replays the trees as a simulator, so candidate policies are judged offline without re-running agents. zarg takes the replay idea: recorded service calls let new procedure versions be tested without models or network.
- **Voyager** (Wang et al., 2023, arXiv 2305.16291): an ever-growing library of executable, composable skills, retrieved for new tasks. zarg takes procedures as code that composes.
- **Agent Workflow Memory** (Wang et al., 2024, arXiv 2409.07429): induces reusable workflows from past trajectories, online or offline, and provides them to guide later tasks. zarg takes inducing from its own transcripts.
- **Muscle Memory for Agents** (Ghiasnezhad Omran et al., 2026, arXiv 2608.08995): argues for compiling recurring patterns into specialised executables instead of retrieving text for an orchestrator to reinterpret; quality-gated. zarg takes compile, not retrieve.

This design is a synthesis for zarg; none of these papers describes it.

## Vocabulary

- **Trace**: one agent run as recorded: its task, cells, outputs, and (new) every service call with its params and result.
- **Problem class**: a named kind of task in this project ("add a Gherkin card from an agenda item"), with a one-line description and example tasks. Classes belong to the project.
- **Role**: a named prompt plus a model reference (`summarize`, `extract-json`, `review-diff`). The decision model picks the role for a model call.
- **Procedure**: a typed, parameterised cell program for one problem class, with its recorded cases, version and stats. Agents call it; they do not rewrite it.
- **Case**: one recorded run of a procedure (or of the code it was compiled from): its params, every service call it made with the recorded result, and its final value.
- **Replay**: running a procedure against a case, with services answered from the recording instead of for real.
- **Curator**: an agent preset that compiles and improves procedures between passes.

## The loop

```
agent run ──record──▶ trace (.zarg/threads/<thread>.rlm.jsonl, with calls)
    ▲                        │
    │ recall                 │ compile (curator, off the critical path)
    │                        ▼
classify task ◀── procedures (.zarg/procedures/, in git) ◀── improve (replay versions)
```

### Phase 1: record and replay

- The kernel host records each service call a cell makes: `{ call, rlm, turn, cell, service, method, params, ok, result | failure, ms }`, redacted like every transcript line, in the thread's `.rlm.jsonl`.
- Model calls made from cells (phase 2's `Llm.complete`) and Decisions calls are service calls too, so a trace has everything that came from outside the kernel.
- `replay(code, params, calls)`: runs cell code in a kernel whose services answer from `calls` in order. It reports:
  - the value the code returned;
  - any divergence, i.e. a call that differs from the recording (other service, method or params) or a call past its end;
  - calls left unused.
- Time and randomness are inputs too, so they are recorded and mocked:
  - In a live run, the kernel's worker wraps `Date.now`, `new Date()`, `performance.now`, `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`. Each read appends its value to the trace, in order (`{ tick, rlm, cell, source, value }`).
  - Replay serves those values back in the same order.
  - Reads past the end of the recording continue deterministically: time advances from the last recorded value at the recorded pace, and randomness comes from a seeded generator. They are reported, not failed. The final value and the service calls still decide whether replay passed.
  - Timers and sleeps run on the recorded clock in replay, so they do not wait.

### Phase 2: classify and recall

- **Classes** live in `.zarg/procedures/classes.json`: `{ name, description, examples: [task texts] }`.
- **Classification:** when an agent starts, one Decisions choice question takes the task's first 600 characters (as atomize does). The criteria are each class's description, plus "none of these". A choice below confidence 0.5 counts as none.
  - This runs alongside the first model call, so it adds no wait.
  - The chosen class and its confidence go into the trace.
- **Recall:** the class's procedures, plus the project's general ones, are loaded into the agent's kernel as functions on a `Procedures` global, with typed declarations like any service (`yield* Procedures.addCardFromAgenda({ item })`).
  - A procedure runs inside the calling cell, with that agent's own services and scope. It never has more authority than the agent calling it.
  - The system prompt says: "Use a procedure when one fits; write new code otherwise."
- **Roles and `Llm.complete`:** a new core service, `Llm.complete({ task, input, schema? })`, makes a model call from a cell.
  - A Decisions choice picks the role from the role catalog (`[roles.<name>] prompt = …, model = …`) by the call's `task`. The generated code never names a model.
  - Tokens count against the calling agent's budget and show in the agents pane.
  - Prompts are redacted before they leave.

### Phase 3: compile

- A `curate` preset agent runs when the core is idle, or after a pass lands. It never runs during a driver question or an active pass.
- It picks a class with at least 3 successful traces since its last run, reads them, and proposes one procedure: name, typed params and result (Effect Schema, as for services), and code. The code is written in terms of the services the traces used.
- The recorded calls of those traces, cut to the part the procedure covers, become its cases.
- **Gate:** the procedure must replay every case with no divergence and the recorded result. It must also typecheck against the declarations of the services it uses.
- Traces that read plugin output an agent was told to treat as untrusted (sub-project 4) are not used for compiling.
- Traces whose recorded calls contain a redaction marker are not used as cases.

### Phase 4: improve

- A procedure has versions. The curator may propose a new version:
  - after a live failure;
  - when live stats show it is slow or makes many model calls;
  - when new traces of its class use it with extra steps the procedure could cover.
- **Promotion:** a new version replaces the current one only if it replays every case of the current one, plus the new cases, and makes fewer service calls or fewer model calls in replay.
- **Live stats per version:** uses, failures, median time, model calls. They sit next to the procedure, updated by the core.
- **Demotion:** 3 live failures in a row, or a replay failure after the code it relies on changed, demotes it.
  - Its class falls back to generating code, which produces fresh traces for the curator.
  - Demotion is recorded, never silent: the agenda shows "procedure X was demoted: <why>".
- **Class upkeep:** the curator may propose merging two classes, or splitting one whose procedures keep diverging. Class changes land like procedure changes.

## Storage

```
.zarg/procedures/
  classes.json
  <class>/<procedure>/
    procedure.ts        # the code; its signature as an exported Schema pair
    meta.json           # class, version, source traces, stats
    cases/<n>.json      # recorded params, calls and result
```

- **In git, landed through the reconcile loop:** a procedure is code agents run, so it is reviewable in history. The developer sees every compiled or improved procedure as a diff in a landed commit.
- **Traces stay local** (`.zarg/threads/` is gitignored). Only the cut-down cases are committed.
- **Size cap:** a case over 256 KiB is not kept (large file reads, big model outputs).

## Errors and safety

- A procedure that throws or diverges at runtime fails the call like any service failure. The agent sees the failure, and the live stats count it.
- Recorded calls are redacted before they are written. A case that still holds a sensitive value is dropped.
- The curator only writes under `.zarg/procedures/`: it is a phase agent with `protect` covering everything else, as plan and implement are protected from requirements.
- The decision model's choices (class, role) are advisory. A wrong class only changes which procedures are offered, and the agent can still write its own code.

## Phases and plans

1. **Record and replay:** call records in transcripts, and the replay runner. Built first; the others depend on its record format.
2. **Classify and recall:** classes, Decisions classification, `Procedures` in the kernel, roles and `Llm.complete`. Starts with a hand-written procedure or two, to prove recall before anything is compiled.
3. **Compile:** the curator preset, the replay gate, and landing through reconcile.
4. **Improve:** versions, promotion and demotion, class upkeep.

## Testing

No real model in `verify`; the stub model and scripted Decisions answer everywhere.

- **Phase 1:**
  - a cell's service calls are recorded in order, redacted;
  - replay of a recorded cell returns the recorded value;
  - a changed param is reported as a divergence at that call;
  - a cell that reads the clock and random numbers replays with the recorded values, and returns the recorded result;
  - reads past the recording continue deterministically and are reported;
  - a cell that sleeps replays without waiting.
- **Phase 2:**
  - a task is classified into the scripted class, and below 0.5 into none;
  - a class's procedures appear typed in the manifest, and cells call them;
  - a procedure cannot call a service its caller lacks;
  - `Llm.complete` picks the scripted role, counts tokens against the budget, and redacts its prompt.
- **Phase 3:**
  - three stub traces compile into a procedure that passes the gate;
  - a candidate that diverges on one case is rejected;
  - traces with untrusted plugin output or redacted values are skipped.
- **Phase 4:**
  - a cheaper version passing all cases is promoted;
  - a version failing one case is not;
  - three live failures demote, with an agenda item.

## Out of scope

- Sharing procedures across projects or users.
- Fine-tuning models from traces.
- Replaying whole agent runs to evaluate policies, as in Dream-RSI; here replay tests procedures only.

## Open questions

- Whether general procedures (not tied to a class) should exist from the start, or only emerge from classes.
- How many recorded cases a class needs before its procedures are trusted over generated code (3 is a starting point).
- Whether the driver should mention in the conversation when it used a procedure (for trust), or only the agents pane.
