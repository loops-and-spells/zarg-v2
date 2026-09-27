# Plugin runtime and SDK

Date: 2026-09-27
Status: approved in conversation, pending written review
Intent: `intent/zarg.md` ("Plugins decide what goes on the graph"; "Secrets never reach a model, a log or the wire")
Sub-project 1+2 of 5. Later: 3 migrate providers, 4 agent access to plugin methods, 5 setup UX by archetype (replaces `/models`).

## Outcome

Every plugin runs locked down: it can do only what you granted it, and nothing else, on any platform Bun runs on. Plugins are written with a structured SDK, and the Gherkin plugin is the first one moved into the runtime.

- A plugin cannot read another plugin's secrets, the disk, the environment, or the network beyond hosts you approved.
- The core has exactly one way to run plugin code: the runtime. No `import` of a plugin anywhere in core, CLI or reconcile.
- The harness does not get slower in any way you can feel: a call into a plugin costs microseconds.

## Evidence (spike, 2026-09-27, Bun 1.4.2, ses 2.3.0)

- `lockdown()` runs under Bun (7 ms). The core-side suites (graph, plugin, plugin-gherkin, model, decisions, kernel, rlm, reconcile, core, client: 342 tests) pass with it preloaded. Effect and varlock work after it. OpenTUI does not (SES removes `Error.isError`); the TUI is a separate process and never loads plugins.
- A plugin in a `Compartment` has no `process`, `Bun`, `require`, global `fetch` or file access. Dynamic `import()` and direct `eval` are refused before the code runs. The Function constructor, prototype pollution, patching shared intrinsics, mutating endowments, another plugin's secret and a non-granted host all failed. `import fs from "node:fs"` fails whichever way it is bundled.
- A 160 KiB plugin bundle containing Effect and Schema loads into a Compartment in 5 ms and runs. A call into a Compartment costs the same as a plain call.
- `lockdown()` and Compartments work inside a Bun Worker. A round trip from the core to a plugin in that Worker is about 10 µs.
- Endo's `compartment-mapper` (one Compartment per npm dependency) fails under Bun: its Babel parser breaks on a CommonJS interop difference. Plugins are therefore bundled into one script each.

## Model

- **Plugin**: one bundle (`zarg-plugin.js`) and one manifest (`zarg-plugin.json`), both produced by `zarg plugin build`.
- **Manifest** (read without running plugin code):
  - `name`: the namespace (`gherkin`, `openrouter`). Config table `[plugins.<name>]`, secrets `<name>.<KEY>`.
  - `service`: the name cells and typed code use (`Gherkin`, `OpenRouter`).
  - `archetype`: `graph` or `provider` (more later). Decides which contract the plugin implements and, in sub-project 5, where it is configured.
  - `config`: JSON Schema of `[plugins.<name>]`.
  - `scopes`: what the plugin asks for:
    - `net`: hosts (`["openrouter.ai"]`), https only
    - `secrets`: key names within its namespace
    - `graph`: `"read"` or `"write"` (write = its tools may propose changes)
    - `fs`: `{ read?: [globs], write?: [globs] }`, paths under the project or `~/.config/zarg/<name>/`
  - `optional`: scopes in the same shape, asked for on first use instead of at load (see "Grants on demand"). The manifest is the ceiling: a scope in neither `scopes` nor `optional` can never be granted.
  - `methods`: each method's `doc`, params and result as JSON Schema, and `agents: true|false` (whether you may grant it to agents; used by sub-project 4).
  - `graph` archetype extras: node types and edge specs (data), and which hooks it implements (`lint`, `agenda`, `suggest`, `render`, `affected`).
- **Grant**: your approval of a plugin's scopes. Stored per user in `~/.config/zarg/grants.json`, keyed by project root, plugin name and a digest of the scopes. Never in the repository: a cloned repo cannot grant its own plugins. A plugin whose scopes change needs a new grant; a new version with the same scopes does not.

## Runtime

```
core process (lockdown() first)                 plugin Worker (lockdown() first)
  PluginHost ── call{plugin,method,params} ──▶    one Compartment per plugin
             ◀─ reply / stream chunk / error ──     endowments: only its granted powers
  powers served here when they need the host:
    secrets (values for its namespace)             snapshot mirror (graph plugins)
    fs (scoped paths), net (scoped fetch)
```

- **Lockdown**: `import "@zarg/plugin/lockdown"` is the first import of the core entry (`packages/core/src/main.ts`) and of the CLI entry for graph commands. The TUI process does not lock down and never loads plugins.
- **One plugin Worker** hosts every plugin, each in its own Compartment. The core stays responsive if a plugin loops: every call has a deadline (default 10 s, per method override in the manifest); a call past its deadline fails, and the Worker is terminated and restarted with all plugins reloaded. A plugin that causes three restarts in ten minutes is disabled and reported on the agenda.
- **Loading**: the host reads the manifest, checks the grant, and sends the bundle and the plugin's granted powers to the Worker. Ungranted plugins do not load; the agenda gets "Plugin `<name>` asks for: …" (sub-project 5 turns that into a consent question). `zarg plugin grant <name>` shows the scopes and asks yes/no in the terminal until then.
- **Powers** (the only things a Compartment receives):
  - `secrets.get(name)`: values from its namespace only; the host sends only granted keys, as they are needed, and they never leave the Worker in a reply.
  - `fetch(url, init)`: https to granted hosts only; redirects are followed only within granted hosts.
  - `fs.read(path)` / `fs.write(path, text)`: served by the host after matching the granted globs, resolved with `realpath` (no `..` or symlink escapes).
  - `graph`: the snapshot mirror (read); tools return `changes` that the host validates and writes, as today.
  - `console`: lines go to the core log, redacted.
- **Grants on demand**: a power call that needs a scope declared in `optional` but not yet granted pauses (its deadline clock stops) while the core asks you on the `main` thread, as an inquiry like the driver's: "Plugin `tracker` wants to reach `api.github.com`" with options allow once, always allow, deny.
  - Always allow updates `grants.json`; deny, or no answer within 10 minutes, fails the call with `NotGranted`. The question stays open after a timeout so you can still answer it for next time.
  - Concurrent calls needing the same scope share one question.
  - A scope not declared in the manifest fails at once with `NotGranted`; it is never asked for.
- **Snapshot mirror**: the Worker holds one copy of the graph snapshot for plugins with `graph` scope. The host sends it at load and a diff after each write, so a lint or tool call does not copy the graph.
- **Protocol**: `call` / `reply` / `stream` / `end` / `cancel` messages, JSON only. Values are encoded with the method's JSON Schema on the way out and decoded by the plugin with its own Schema on the way in. Typed failures travel as `{ _tag, message }`, as the kernel does today.
- **Only one loader**: a test fails if any package other than `@zarg/plugin` and `@zarg/plugin-sdk` imports a plugin package (`@zarg/plugin-gherkin*`).

## SDK (`@zarg/plugin-sdk`)

Plugins depend only on the SDK and bundleable libraries (Effect is fine).

```ts
export const Gherkin = definePlugin({
  name: "gherkin",
  service: "Gherkin",
  archetype: "graph",
  config: Schema.Struct({}),
  scopes: { graph: "write" },
  nodes: { state: StateProps, card: CardProps },
  edges: { arrives: { from: "card", to: "state", min: 1, max: 1 }, … },
  methods: { addCard: { doc: "…", params: AddCard, success: CallResult, agents: true }, … },
  hooks: { lint: [clauseShape, stateText], agenda, suggest, render, affected },
  make: () => Effect.gen(function* () {
    const graph = yield* Graph          // present because scopes.graph is granted
    return { addCard: (p) => … }
  }),
})
```

- `definePlugin` returns a typed value. Inside the plugin, powers are ordinary Effect services from the SDK (`Secrets`, `Http`, `Files`, `Graph`), built from the endowments; a power not granted is not in the plugin's Layer.
- `zarg plugin build <dir>` bundles with `Bun.build` and writes the manifest (JSON Schema from each Schema). It refuses imports of `node:*` and Node built-ins and references to `Bun`, `process`, `require` and global `fetch`, with a message naming the scope to ask for. It refuses code SES would reject (`import(...)`, direct `eval`). This is for honest authors; the Compartment is the enforcement.
- `zarg plugin test` helpers run a built plugin in a locked Worker with fake powers, the same runtime the core uses.

## Gherkin moves into the runtime

- `@zarg/plugin-gherkin` is rewritten on the SDK. Its tools, lints, agenda, suggest, render and `affectedCards` become methods and hooks. Core, reconcile and the CLI call `affected` through the host instead of importing it.
- Node prop validation (`nodes`) runs in the plugin: the host sends the proposed changes and gets findings back. Edge specs stay data in the manifest and are checked by the host as today.
- Its build output is produced by the package's `build` task; `mise run zarg` and `verify` depend on it.
- Gherkin asks for `graph: "write"` only. Its grant is created on first use without a question, because it is first-party and has no network, secret or file scope; any plugin with such a scope always asks.

## Out of scope (later sub-projects)

- Providers as plugins, the `provider` archetype contract, zarg-router's `warm` and `systemone` as its methods (3).
- Plugin methods as REPL services for agents, agent grants per preset (4).
- Consent, config and login screens in the TUI by archetype (5).
- Per-dependency Compartments (blocked by compartment-mapper under Bun).
- CPU and memory limits beyond the call deadline and Worker restart.

## Errors

- A plugin that throws while loading, or whose manifest does not match its bundle (name, service, archetype), is not loaded; the agenda says why.
- A power used outside its grant fails the call with `{ _tag: "NotGranted", message }` naming the scope to request.
- A Worker crash fails the calls in flight with `{ _tag: "PluginCrashed" }`, then the Worker restarts.

## Testing

No real model in `verify`.

- Escape tests from the spike become permanent tests: each probe fails inside a plugin Compartment in the Worker.
- Secrets: a plugin reads its own granted key; another plugin's key, an ungranted key of its own, and the raw vault are unreachable; a secret value never appears in a reply, the log or an error.
- Net and fs: a scoped fetch reaches a granted host (local test server) and fails for others, including by redirect; fs globs refuse `..` and symlink escapes.
- Grants on demand: an optional scope's first use raises one inquiry; allow once lets that call through only; always allow persists and later calls do not ask; deny and the 10-minute timeout fail with `NotGranted`; an undeclared scope never asks; two concurrent calls raise one inquiry.
- Liveness: a plugin that loops forever fails its call at the deadline, the Worker restarts, other plugins keep working; three restarts disable the plugin.
- Loader: the import rule test; an ungranted plugin does not load and raises an agenda item.
- Gherkin: the existing Gherkin, plugin host, rlm graph and core suites pass with Gherkin running in the runtime.
- Speed: a Gherkin tool call through the runtime stays within 1 ms of the in-process call on this repo's graph (measured in a test, reported, not a hard gate on CI).
