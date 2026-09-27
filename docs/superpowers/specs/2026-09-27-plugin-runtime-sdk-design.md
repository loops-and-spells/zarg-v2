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
- A plugin cannot take the core down, pass itself off as first-party, run code at install time, or reach another plugin through shared memory.

## Evidence (spike, 2026-09-27, Bun 1.4.2, ses 2.3.0)

- `lockdown()` runs under Bun (7 ms). The core-side suites (graph, plugin, plugin-gherkin, model, decisions, kernel, rlm, reconcile, core, client: 342 tests) pass with it preloaded. Effect and varlock work after it. OpenTUI does not (SES removes `Error.isError`); the TUI is a separate process and never loads plugins.
- A plugin in a `Compartment` has no `process`, `Bun`, `require`, global `fetch` or file access. Dynamic `import()` and direct `eval` are refused before the code runs. The Function constructor, prototype pollution, patching shared intrinsics, mutating endowments, another plugin's secret and a non-granted host all failed. `import fs from "node:fs"` fails whichever way it is bundled.
- A 160 KiB plugin bundle containing Effect and Schema loads into a Compartment in 5 ms and runs. A call into a Compartment costs the same as a plain call.
- `lockdown()` and Compartments work inside a Bun Worker (about 10 µs per round trip) and inside a Bun child process started with an empty environment: about 6 µs per round trip over IPC, 34 ms from spawn to ready (lockdown included), 59 MiB resident per process.
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
    - `fs`: `{ read?: [globs], write?: [globs] }`, any absolute or `~/` path; broad globs (`~/**`, `/**`) are flagged when you are asked
  - `optional`: scopes in the same shape, asked for on first use instead of at load (see "Grants on demand"). A kind may be `"ask"` instead of a list (`optional: { fs: { read: "ask" }, net: "ask" }`): the plugin does not know the paths or hosts ahead of time, and you are asked about the concrete one when it is used. A plugin may prompt only for what `scopes` or `optional` declare.
  - `methods`: each method's `doc`, params and result as JSON Schema, and `agents: true|false` (whether you may grant it to agents; used by sub-project 4).
  - `graph` archetype extras: node types and edge specs (data), and which hooks it implements (`lint`, `agenda`, `suggest`, `render`, `affected`).
- **Grants you start**: `zarg plugin grant <name> --fs-read <path> | --fs-write <path> | --net <host> | --secret <KEY>` adds a grant the manifest never asked for (a path you set in the plugin's config, a new data drive). Because you start it, it is not bounded by the manifest; it is still bounded by the plugin's own secret namespace.
- **Grant**: your approval of a plugin's scopes. Stored per user in `~/.config/zarg/grants.json`, keyed by project root, plugin name and a digest of the scopes. Never in the repository: a cloned repo cannot grant its own plugins. A plugin whose scopes change needs a new grant; a new version with the same scopes does not.

## Runtime

```
core process (lockdown() first)                 one process per plugin (lockdown() first, empty env)
  PluginHost ── call{method,params} over IPC ──▶  one Compartment holding the plugin
             ◀─ reply / stream chunk / error ──     endowments: only its granted powers
  powers served here, by the host:                  snapshot mirror (graph plugins)
    secrets (its namespace only), fs (scoped paths), net (scoped fetch)
```

- **Lockdown**: `import "@zarg/plugin/lockdown"` is the first import of the core entry (`packages/core/src/main.ts`) and of the CLI entry for graph commands. The TUI process does not lock down and never loads plugins.
- **One process per plugin**: each plugin runs in its own Bun child process (`process.execPath`), started with an empty environment and a working directory it cannot use (it has no file access), holding one Compartment. A plugin that loops, exhausts memory or crashes the engine takes down only its own process; plugins share no memory, so there is no side channel between them. Every call has a deadline (default 10 s, per method override in the manifest); a call past its deadline fails, and that plugin's process is killed and restarted. A plugin that causes three restarts in ten minutes is disabled and reported on the agenda. Processes start lazily on first use and stop after 10 idle minutes.
- **Loading**: the host reads the manifest, checks the grant, starts the plugin's process and sends it the bundle; powers are served by the host over the same channel. Ungranted plugins do not load; the agenda gets "Plugin `<name>` asks for: …" (sub-project 5 turns that into a consent question). `zarg plugin grant <name>` shows the scopes and asks yes/no in the terminal until then.
- **Powers** (the only things a Compartment receives):
  - `secrets.get(name)`: values from its namespace only; the host sends only granted keys, as they are needed, and only to that plugin's process.
  - `fetch(url, init)`: https to granted hosts only, matched on the parsed hostname (`https://openrouter.ai@evil.com` is `evil.com`); redirects are followed by the host and only within granted hosts; the plugin gets back a plain value (status, headers, body text or byte chunks), never a live host object.
  - `fs.read(path)` / `fs.write(path, text)`: served by the host after matching the granted globs. The host opens the file, then checks the opened file's real path against the grant before reading or writing, so a symlink swapped in between the check and the open cannot redirect it; `..` is resolved before matching.
  - Every power returns plain JSON-shaped data, hardened; no host function, prototype or stream object crosses into a Compartment.
  - `graph`: the snapshot mirror (read); tools return `changes` that the host validates and writes, as today.
  - `console`: lines go to the core log, redacted.
- **Grants on demand**: a power call that needs a scope declared in `optional` but not yet granted pauses (its deadline clock stops) while the core asks you on the `main` thread, as an inquiry like the driver's: "Plugin `tracker` wants to reach `api.github.com`" with options allow once, always allow, deny.
  - Always allow updates `grants.json`; deny, or no answer within 10 minutes, fails the call with `NotGranted`. The question stays open after a timeout so you can still answer it for next time.
  - Concurrent calls needing the same scope share one question.
  - A scope not declared in the manifest (and not granted by you) fails at once with `NotGranted`; it is never asked for.
  - For an `"ask"` kind the question names the concrete path or host, with options: allow this one, allow its folder (`/mnt/data/**`) or domain, always allow, deny.
  - Paths from a plugin's config are not granted automatically (project config is in the repository, so a cloned repo could point a plugin at `~/.ssh`); their first use is asked like any other.
- **YOLO**: a switch that lets every declared scope through without asking. Turned on for a core's lifetime with `zarg --yolo` (and `zarg core start --headless --yolo`), or toggled in the TUI with `/yolo [on|off] [<plugin>]` (no plugin: all plugins). It is never stored in config. It saves no grants: when it is turned off, anything not granted before is asked again. The status line shows `YOLO` while it is on, and every call it let through is logged with the scope it used. YOLO never passes an undeclared scope, never reaches another plugin's secret namespace, and never takes a plugin out of its Compartment.
- **Snapshot mirror**: each plugin process with `graph` scope holds one copy of the graph snapshot. The host sends it at load and a diff after each write, so a lint or tool call does not copy the graph.
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
- `zarg plugin test` helpers run a built plugin in its own locked process with fake powers, the same runtime the core uses.

## Gherkin moves into the runtime

- `@zarg/plugin-gherkin` is rewritten on the SDK. Its tools, lints, agenda, suggest, render and `affectedCards` become methods and hooks. Core, reconcile and the CLI call `affected` through the host instead of importing it.
- Node prop validation (`nodes`) runs in the plugin: the host sends the proposed changes and gets findings back. Edge specs stay data in the manifest and are checked by the host as today.
- Its build output is produced by the package's `build` task; `mise run zarg` and `verify` depend on it.
- Gherkin asks for `graph: "write"` only. Its grant is created on first use without a question, because it is first-party and has no network, secret or file scope; any plugin with such a scope always asks.
- **First-party means shipped with zarg**, never a name: a plugin is first-party only when its bundle is loaded from zarg's own installation directory and its SHA-256 matches the list built into that zarg release. A plugin named `gherkin` from anywhere else is an ordinary plugin and asks.

## Installing plugins

- `zarg plugin add <path|url|package>` fetches the plugin's built bundle and manifest (from a directory, a tarball, or an npm package's published files) and unpacks them under `~/.config/zarg/plugins/<name>/<sha256>/`. It never runs package lifecycle scripts (`preinstall`, `postinstall`, …) and never installs the package's dependencies: a plugin's dependencies are already inside its bundle.
- Projects list the plugins they use in `.zarg/config.toml` (`[plugins.<name>] source = …`); a listed plugin that is not installed is an agenda item, never installed silently.

## Asking you well

- The approval question shows every scope, and warns about combinations that let data leave: graph `read` or `fs.read` together with any `net` host ("can read your graph and send it to `x.com`"), and any secret together with a broad `net` (`"ask"` or a wildcard).
- YOLO's log records every call it let through with its plugin, scope and target, so you can review what happened while it was on.

## Keeping the sandbox honest

- `ses` is pinned to an exact version in the root `package.json`; upgrading it, or Bun, requires the escape suite to pass (it runs in `verify`).
- The escape suite (from the spike, kept as tests) runs a hostile plugin in the real runtime: `process`, `Bun`, `require`, global `fetch`, the Function constructor, `import()` and `eval` smuggling, prototype pollution, patching shared intrinsics, mutating endowments, another plugin's secret, a non-granted host (including by `user@host` URLs and redirects), a path escape by `..` and by a swapped symlink, and a host object leaking through a power's return value.

## Plugin output reaching agents (carried to sub-project 4)

A plugin cannot touch the disk, but its results can reach an agent that holds `Fs` and `Sh`, and text in them can steer that agent. The sandbox cannot close this; sub-project 4 must:
- mark every plugin result in an agent's context as untrusted data from that plugin (a fenced block naming the plugin), never as instructions;
- let an agent call only plugin methods granted to agents (per preset), and never let a plugin's result trigger another call by itself;
- show in the approval question which agents may call the plugin.

## Out of scope (later sub-projects)

- Providers as plugins, the `provider` archetype contract, zarg-router's `warm` and `systemone` as its methods (3).
- Plugin methods as REPL services for agents, agent grants per preset (4).
- Consent, config and login screens in the TUI by archetype (5).
- Per-dependency Compartments (blocked by compartment-mapper under Bun).
- CPU and memory limits beyond the call deadline and process restart.

## Errors

- A plugin that throws while loading, or whose manifest does not match its bundle (name, service, archetype), is not loaded; the agenda says why.
- A power used outside its grant fails the call with `{ _tag: "NotGranted", message }` naming the scope to request.
- A plugin process crash fails that plugin's calls in flight with `{ _tag: "PluginCrashed" }`, then its process restarts; other plugins are unaffected.

## Testing

No real model in `verify`.

- The escape suite (above) passes against the real runtime.
- Isolation: a plugin that allocates without bound or calls `process.abort`-like engine crashes (a hostile busy loop, a runaway allocation) kills only its own process; the core and other plugins keep answering.
- First-party: a bundle named `gherkin` outside zarg's install directory, or with a different hash, is not auto-granted.
- Install: `zarg plugin add` of a package with a `postinstall` script does not run it (a marker file it would write is absent).
- Warnings: a manifest with graph read and a `net` host produces the data-leaves warning in the question.
- Secrets: a plugin reads its own granted key; another plugin's key, an ungranted key of its own, and the raw vault are unreachable; a secret value never appears in a reply, the log or an error.
- Net and fs: a scoped fetch reaches a granted host (local test server) and fails for others, including by redirect; fs globs refuse `..` and symlink escapes.
- Grants on demand: an optional scope's first use raises one inquiry; allow once lets that call through only; always allow persists and later calls do not ask; deny and the 10-minute timeout fail with `NotGranted`; an undeclared scope never asks; two concurrent calls raise one inquiry.
- `"ask"` kinds: a read of an undeclared-in-advance path under `fs: { read: "ask" }` asks with that path; "allow its folder" grants the directory glob; a plugin without an `"ask"` kind gets `NotGranted` without a question.
- Grants you start: a path granted with `zarg plugin grant --fs-read` is readable though the manifest never listed it; another plugin's secret cannot be granted this way.
- YOLO: `--yolo` and `/yolo on|off [plugin]` turn it on and off; with it on, declared scopes pass without a question and each pass is logged; nothing is written to `grants.json`; after it is turned off the same call asks again; an undeclared scope and another plugin's secret still fail.
- Liveness: a plugin that loops forever fails its call at the deadline, its process restarts, other plugins keep working; three restarts disable the plugin.
- Loader: the import rule test; an ungranted plugin does not load and raises an agenda item.
- Gherkin: the existing Gherkin, plugin host, rlm graph and core suites pass with Gherkin running in the runtime.
- Speed: a Gherkin tool call through the runtime stays within 1 ms of the in-process call on this repo's graph (measured in a test, reported, not a hard gate on CI).
