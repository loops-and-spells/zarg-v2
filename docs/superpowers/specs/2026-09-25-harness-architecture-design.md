# zarg v2 harness architecture

Date: 2026-09-25
Status: approved in conversation, pending written review

## Intent

zarg is a coding-agent harness. You converse with a driver agent to continuously refine product requirements. The requirements live as an atomic Gherkin user action graph. As a side effect, a continuous sync agent reconciles graph changes into implementation code, like a virtual DOM whose output is generated code instead of DOM patches.

Success means: you refine requirements in conversation, and code converges to match without you asking "implement X". The first proof point is Claude Code building zarg through zarg's own graph.

Prior art this design learns from:

- `~/Git/colony`: atomic Gherkin cards and the walk graph. Lessons kept: hard limits enforced at the mutation choke point (not only in prompts), deterministic lints before LLM judgment, error messages that steer the agent, state outside the context window, one verify gate. Lesson fixed: edge labels duplicated Given text and could drift.
- `~/Git/zarg` (v1): headless worker, UI as pure client, seq-numbered event log, interrupts answered by resume, schema-validated plugin graph domains, Effect everywhere. Lessons fixed: AG-UI in name only, stringly-typed custom events and `substrate.call` back door, heavy DoltLite storage and authority rules, a 25-hook plugin API, TUI depending on core internals, conversational agent doing the implementation itself.

## Constraints

- Toolchain: mise manages tool versions, bun is the runtime (see `AGENTS.md`).
- All code uses Effect `4.0.0-rc.x` (npm tag `rc`): `Context.Service` services, `Layer` DI, `Schema` for every file and wire format, tagged errors.
- Monorepo: one module per package under `packages/`, tasks orchestrated by mise.
- UI is OpenTUI. The agent core is headless.

## 1. Packages and dependency direction

```
packages/
  graph/           @zarg/graph           JSON graph store on disk: load, index, query, snapshot, diff. Depends on effect only.
  plugin/          @zarg/plugin          Plugin contract.
                                           ./server  node/edge types, lints, tools, reactors, agenda, projection,
                                                     plus PluginHost and the write pipeline
                                           ./client  view definitions, state decoders (no server dependencies)
  core/            @zarg/core            Headless agent server: agents, threads, sync dispatcher,
                                         AG-UI endpoint. Depends on graph, plugin/server, @ag-ui/core, @effect/platform-bun.
  client/          @zarg/client          AG-UI SSE client, pure event reducer, client-plugin host.
                                         Depends on @ag-ui/core and plugin/client. Never on core.
  cli/             @zarg/cli             `zarg` binary. OpenTUI shell (uses client only) and graph commands
                                         (phase 1: in-process PluginHost; later: routed through core).
  plugin-gherkin/  @zarg/plugin-gherkin  First plugin. ./server and ./client subpath exports.
```

Rules:

- The server/client split of every plugin is a package `exports` subpath. UI code imports only `/client`.
- A boundary test fails if `@zarg/client`, or the TUI part of `@zarg/cli`, imports `@zarg/core` or any `/server` subpath.
- Model provider and agent loop start inside `core`. They move to their own package only when a second consumer needs them.
- One core process per project. It is the only writer of the graph and hosts all agent threads.

## 2. `@zarg/graph`

A generic property graph. It knows nothing about Gherkin.

### On disk

One canonical JSON file per node at `.zarg/graph/nodes/<id>.json`. Canonical means sorted keys, two-space indentation and a trailing newline, so git diffs stay small and files compare byte for byte.

```json
{
  "id": "UX-0003",
  "type": "gherkin/card",
  "props": { "title": "Visitor picks Pro", "when": "the visitor picks Pro" },
  "edges": [
    { "type": "gherkin/arrives", "to": "S-0002" },
    { "type": "gherkin/then", "to": "S-0004" }
  ]
}
```

- Node and edge types are namespaced `<plugin>/<type>`.
- Ids match `^[A-Za-z0-9._-]+$`. The owning plugin picks a prefix. The store offers `nextId(prefix)`.
- Edges are stored on their source node. Inbound edges are an in-memory index.
- The store validates only the envelope. Props are validated by the write pipeline against plugin schemas.

### Snapshot and queries

A snapshot is an immutable in-memory value: nodes by id plus the inbound index. Each node carries an in-memory `rev` (never written to disk). Queries are pure functions over a snapshot: `get`, `byType`, `out`, `in`, `neighbors(id, k)`, `reachable`, `hasCycle(edgeType)`.

### Diff

`diff(before, after)` is pure and keyed by node id:

```ts
{
  added: Node[]
  removed: Node[]
  changed: { id, before: Node, after: Node, props: JsonPatch, edges: { added, removed, changed } }[]
}
```

### Service

```ts
class GraphStore extends Context.Service<GraphStore, {
  readonly snapshot: Effect<Snapshot>
  readonly commit: (changes: Changeset) => Effect<Commit, GraphError>
  readonly commits: Stream<Commit> // Commit = { rev, before, after, diff }
}>()("@zarg/graph/GraphStore") {}
```

- A `Changeset` is a list of `Put(node)` and `Remove(id)`, plus the `rev` of every node it read.
- `commit` rejects with `StaleNode` if any read node changed since, rejects with `DanglingEdge` if an edge targets a missing node, writes each file atomically (temp file plus rename), publishes the new snapshot and emits the commit.
- A file watcher turns outside edits (git checkout, merge, hand edit) into normal commits, so downstream consumers cannot tell them apart from agent edits.
- File access goes through the platform `FileSystem` service. Tests use an in-memory layer.
- Errors: `InvalidNode`, `DanglingEdge`, `StaleNode`, `ParseError{file}`, `IoError`.

Known limit: a multi-file commit is not atomic as a whole. A crash mid-commit can leave a partial write. The next load reports dangling edges and git restores the files. Add a write-ahead log only if this happens in practice.

## 3. Plugin contract

A plugin is a plain value with two halves. Every field except `name` is optional, so a plugin can contribute any part of the slice.

### Server half

```ts
export default Plugin.server({
  name: "gherkin",
  requires: [],                                   // plugins whose types this one references
  nodes: { state: StateProps, card: CardProps },  // Schemas, registered as "gherkin/state", "gherkin/card"
  edges: {                                        // cardinality is data, checked by core
    arrives: { from: "card", to: "state", min: 1, max: 1 },
    given:   { from: "card", to: "state", max: 3 },
    then:    { from: "card", to: "state", min: 1, max: 5 },
  },
  lints:   [/* (snapshot, diff) => Effect<Finding[]> */],
  tools:   [/* Schema params, handler returns a Changeset */],
  agenda:  (snapshot) => AgendaItem[],
  reactor: (commit) => Effect<void>,              // receives commits filtered to this plugin's types
  project: (snapshot) => View,                    // JSON state published at /plugins/<name>
  layer:   PluginServicesLive,                    // services the plugin needs, through Effect DI
})
```

### Client half

```ts
export default Plugin.client({
  name: "gherkin",
  state: GherkinView,                             // Schema that decodes /plugins/gherkin
  views: [{ id: "graph", title: "User action graph", render: (state, ctx) => /* OpenTUI renderable */ }],
})
```

### How plugins are hosted

`PluginHost` and the write pipeline live in `@zarg/plugin/server`, so both core and the phase 1 CLI use the same code.

- Write pipeline, used by every change (agent tool, reactor, outside edit): decode props with plugin schemas, check edge cardinality, run every plugin's lints on the diff, then `GraphStore.commit`. An `error` finding blocks the commit and its message returns to the agent as the tool result. A `warn` finding is stored and surfaces on the agenda.
- Reactors each run in their own fiber and see only commits touching their types. A reactor failure is isolated and becomes an agenda finding.
- After each commit, core calls `project`, diffs against the previous projection and emits an AG-UI `STATE_DELTA` at `/plugins/<name>`. Plugins never emit events directly.
- Loading is a static list: `PluginHost.layer([gherkin, ...])`. Runtime discovery is out of scope.
- A plugin may add edges to another plugin's types only if it lists that plugin in `requires`.

## 4. Gherkin plugin: the user action graph

States are nodes. Cards are transitions. A card never copies state text, so "Then X" and "Given X" cannot drift apart.

```
gherkin/state  { text }                 the Given/Then sentence, stored once
gherkin/card   { title, when }          one When
  arrives -> state   exactly 1          the arrival Given
  given   -> state   0..3               extra context Givens
  then    -> state   1..5               outcomes
```

- Rendered Gherkin is built from the referenced states.
- Card-to-card flow is derived: A flows to B when one of A's `then` states is B's `arrives` state. It is never stored.
- A choice (option A, B or N) is N cards that share one arrival state, each with its own When.
- An outcome branch (success, failure) is one card per outcome, each with its own When and Then states.
- Rewording a state is one file edit. Every card that uses it renders the new text, and the diff names exactly one changed node.

### Example

```
S-0002 "the plan picker is shown"
  <- then     UX-0001 "the visitor clicks Pricing"
  -> arrives  UX-0002 "the visitor picks Free"   then S-0003 "the account form is shown"
  -> arrives  UX-0003 "the visitor picks Pro"    then S-0004 "the payment form is shown"
S-0004 "the payment form is shown"
  -> arrives  UX-0004 "the visitor pays with a valid card"  then S-0003, S-0005 "a receipt is emailed"
  -> arrives  UX-0005 "the card is declined"                 then S-0004, S-0006 "a decline message is shown"
```

### Lints

Structural only, because wording cannot desync:

- Cardinality from the edge declarations.
- One When per card, each clause of 15 words or fewer, no "and" chaining, no `if`.
- Near-duplicate state text is a warning.

### Agenda items

Dead-end states (no card leaves), unreached states (no card arrives), near-duplicate states, cards over size limits.

### Tools

`add-state`, `add-card`, `reword-state`, `split-card`, `link`, `unlink`, `remove`. Tools search existing states before creating a new one.

## 5. Core runtime

### Process and transport

- `zarg-core` runs once per project and writes `.zarg/run/core.json` (pid, socket path, token). The CLI attaches, or starts core detached if it is not running.
- AG-UI 1.0 over HTTP on a unix socket at `.zarg/run/core.sock` (`Bun.serve`). A TCP port is opt-in by flag.
- `POST /runs` accepts `RunAgentInput` and streams that run's events over SSE.
- `GET /stream?since=<seq>` streams every thread's events, including plugin `STATE_*` deltas, for reconnect and replay.

### Threads

A thread is one continuous conversation line (AG-UI `threadId`). A run is one stretch of agent work in a thread, ending in `RUN_FINISHED` with outcome `success` or `interrupt`.

| Thread | Count | Agent | Scope |
|---|---|---|---|
| driver threads | 1..N per project; `main` always exists | driver agent | its focus |
| `sync` | 1 per project | sync agent | all commits |

- Each driver thread has a focus: a subgraph such as "cards reachable from S-0002". The agent proposes the focus by inquiry when you open a thread. Agenda items outside every focus go to `main`.
- A thread is told about other threads' commits inside its focus.
- Event logs are appended to `.zarg/threads/<threadId>.jsonl`.
- A thread is not the agent's memory. Each run builds context from the focused subgraph, the agenda and only the last few messages.

### Driver agent

The driver leads the conversation. It does not wait for messages.

```
loop:
  read the agenda for this thread's focus
  pick the most important item; research it (graph queries, read-only repo access)
  ask an inquiry: question, options, a recommendation, and "something else"
  apply the answer as graph changes through the write pipeline
  when the agenda is empty, ask "what next?" with options drawn from the graph
```

- An inquiry is a standard AG-UI 1.0 interrupt: `RUN_FINISHED{outcome: {type: "interrupt", interrupts: [...]}}` with `reason: "inquiry"`, `metadata: {options[{id, label, recommended?, why?}], allowOther: true, about: [nodeIds]}` and a `responseSchema`. The answer arrives as `RunAgentInput.resume`.
- The driver always brings a recommendation. It never asks an empty question.
- You can interject any time. Your message cancels the pending inquiry and is considered before the next item.
- The driver changes the graph only. It never edits code.

### Sync agent

- Subscribes to commits, debounced (about 2 seconds of quiet), and dispatches the diff to plugin reactors.
- Changes code only. It never edits requirements. A requirement it cannot satisfy becomes an agenda finding for a driver thread.
- What the sync agent owns in code (tagged regions, fully generated output, or a hybrid) is decided in its own spec.

### Conflicts

When a commit fails with `StaleNode`, the agent compares base (what it read), theirs (current) and mine (its change).

- Obvious (different props or edges touched, or both changes express the same intent): the agent merges, re-commits and notes the merge in its thread.
- Not obvious: an inquiry with options: the merged version (recommended, with reasons), keep theirs, keep mine, or something else.
- The sync agent re-reads and continues when obvious, otherwise it raises an agenda finding for the owning driver thread.

### Core services

`GraphStore`, `PluginHost`, `Model`, `Workspace` (repo-scoped file and command access), `Threads`, `Sync`. The model provider choice is decided in its own spec.

## 6. Errors and testing

### Errors

- Tagged errors throughout: `InvalidNode`, `DanglingEdge`, `StaleNode`, `LintFailed`, `ParseError`, `ModelError`, `ToolError`.
- Tool errors never crash a run. They return to the agent as tool results that say what to fix.
- Model errors retry with backoff, then end the run with `RUN_ERROR`.
- A malformed node file does not stop core. It is skipped and raised as an agenda item.

### Testing

`bun test` in each package.

- `@zarg/graph`: unit tests for snapshot, queries and diff. Store tests on the in-memory `FileSystem`: round trip, outside edits become commits, dangling edges, stale nodes.
- Plugins: each lint, tool and agenda function against small hand-built snapshots. The gherkin plugin tests the pricing example.
- Core: a stub `Model` layer replays scripted tool calls to test the driver loop, inquiry and resume, conflict merge and sync dispatch without a network.
- Contract: every event core emits validates against the `@ag-ui/core` 1.0 schemas.
- Boundaries: import rules from section 1.
- One gate: `mise run verify` runs typecheck and every package's tests. Its exit code is the verdict.

## 7. Build order: dogfood first

### Phase 1: graph via CLI, Claude Code as the agents

- `@zarg/graph`, `@zarg/plugin/server`, `@zarg/plugin-gherkin/server`.
- The write pipeline runs in-process in the CLI. No core server yet.
- Generic, plugin-driven commands. JSON output by default, `--pretty` for people:

  ```
  zarg tool list
  zarg tool call <plugin>/<tool> '<json>'
  zarg show <id>
  zarg render [--focus <id>]
  zarg query neighbors <id> --k <n>
  zarg agenda [--focus <id>]
  zarg diff --since <git-ref>
  zarg lint
  ```

- Claude Code skills in `.claude/skills/`, referenced from `AGENTS.md`:
  - `zarg-drive`: Claude acts as the driver. Reads `zarg agenda`, researches, asks with `AskUserQuestion` (recommendation first, free text through "Other"), applies answers with `zarg tool call`, follows the conflict rule, loops.
  - `zarg-sync`: Claude acts as the sync agent. Reads the last synced git commit from `.zarg/sync.json`, runs `zarg diff --since` on it, implements code for changed cards, runs `mise run verify`, then advances `.zarg/sync.json`.
- Code links to cards with `// @card <id>` comments, found by grep. This replaces prd-trace. It is temporary until the sync spec decides code ownership.
- zarg's own requirements are seeded into `.zarg/graph` at the start of phase 1.

Phase 1 is done when Claude Code, using only the two skills, adds a zarg requirement to the graph and syncs it into working code that passes `mise run verify`.

### Phase 2: core

The core process, AG-UI over HTTP and SSE, threads, the stub-model tests, and zarg's own driver and sync agents replacing the skills. From then on, the CLI routes writes through core when core is running.

Phase 2 is split into three specs:

- **2a, agent runtime:** `docs/superpowers/specs/2026-09-25-agent-runtime-design.md`. Model access, decisions, the kernel, services, and the RLM as the unit of agency. It replaces plugin `tools` with plugin `services` and supersedes the "Core services" list in section 5.
- **2b, core process:** AG-UI, threads and focus, and the driver and sync loops on top of 2a.
- **2c, sync code ownership:** tagged regions, fully generated output, or a hybrid. This replaces the phase 1 `// @card` grep convention.

Phase 2 work, including everything phase 1 deferred:

- Core process
  - `zarg-core`, one per project, with `.zarg/run/core.json` and the unix socket `.zarg/run/core.sock`.
  - AG-UI 1.0 endpoints `POST /runs` and `GET /stream?since=`, plus a contract test against the `@ag-ui/core` schemas.
  - The CLI attaches to core, starting it if needed, and sends graph writes through it.
- Graph store (deferred from phase 1)
  - The `commits` stream and the file watcher that turns outside edits (git checkout, merge, hand edit) into normal commits.
  - An in-memory snapshot cache in core. The phase 1 store rereads the directory on every call.
  - Single-writer commits in core. That closes the race where two processes committing within milliseconds both pass the stale check.
  - A write-ahead log only if partial multi-file commits happen in practice.
- Plugin contract (deferred from phase 1)
  - `reactor`: receives commits filtered to the plugin's types.
  - `project`: plugin state published as AG-UI `STATE_DELTA` at `/plugins/<name>`.
  - `layer`: services the plugin needs, provided through Effect DI.
  - Effect-returning lints only if a lint needs I/O. Phase 1 lints are pure functions.
- Threads and agents
  - Driver threads (1..N, `main` always exists), each with a focus. The `sync` thread. Event logs in `.zarg/threads/<threadId>.jsonl`. Context built from the graph, never by replaying the thread.
  - The driver loop with inquiry interrupts (`RUN_FINISHED` outcome `interrupt`, answered with `RunAgentInput.resume`), your interjections, and "what next?" when the agenda is empty.
  - The sync agent: debounced commit subscription dispatching to reactors, with findings raised to the agenda.
  - The conflict rule with `StaleNode` naming the thread that changed the node.
  - Core services `Model`, `Workspace` and `Threads`.
- Agenda sources: sync findings (a card the sync agent could not implement, code that drifted from its card) and your unfinished goal statement.
- Tests: a stub `Model` layer that replays scripted tool calls, covering the driver loop, inquiry and resume, conflict merge and sync dispatch.
- Only if needed: a `split-card` tool. Phase 1 relies on edge cardinality to keep cards small.

### Phase 3: client and TUI

- `@zarg/client`: an AG-UI SSE client, a pure event reducer, and the host for client plugins.
- Each plugin's client half: a `state` schema and `views`. The gherkin plugin gets a user action graph view.
- The OpenTUI shell in `@zarg/cli`, replacing the phase 1 placeholder: inquiry pickers (recommended option preselected, free-text last), thread switching, plugin views.
- The import-boundary test: `@zarg/client` and the TUI never import `@zarg/core` or any `/server` subpath.

## Out of scope

- Runtime plugin discovery.
- Transports beyond the unix socket and opt-in TCP.
- The model provider choice (its own spec).
- Sync code ownership (its own spec).
