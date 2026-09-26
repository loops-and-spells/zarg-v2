# Phase 2a: agent runtime

Date: 2026-09-25
Status: approved in conversation, pending written review
Parent: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md` (phase 2)
Requirements served: UX-0008..UX-0025 (driver loop, what next, conflicts, sync loop), UX-0026..UX-0033 (provider login and logout), UX-0034..UX-0039 (model setup), UX-0040..UX-0044 (visible agent work) and UX-0045..UX-0048 (secret safety, preset boundary) in `.zarg/graph`

## Intent

Phase 2 is split into three specs:

- **2a, this spec: agent runtime.** How any zarg agent thinks and acts: model access, decisions, the kernel it writes code in, the services it can use, and the RLM as the unit of agency.
- **2b: core process.** AG-UI over HTTP and SSE, threads and focus, and the driver and sync loops built on 2a.
- **2c: sync code ownership.** What the sync agent owns in the code.

2a gives 2b everything it needs to run the driver and sync agents without a UI.

## Decisions

- zarg runs its own tool loop. It does not delegate to agent CLIs.
- The model's only tool is `exec({code})`. Code runs in a kernel, and **every integration is a yieldable Effect service**: `yield* Graph.render(...)`, `yield* Decisions.decide(...)`, `yield* Rlm.exec(...)`. There are no injected globals and no stringly `host(kind, payload)` calls.
- **The RLM is the unit of agency.** Every agent run, including the driver and each sync pass, is an RLM. An RLM has its own encapsulated runtime built from its layer, like an Effect `ManagedRuntime`. RLMs call RLMs to fold context. There is no separate sub-agent concept.
- An RLM is told exactly what its layer provides. Its prompt and its typecheck come from the same manifest.
- An RLM's layer comes from its preset, not from its parent. A child may be wider or narrower than its parent. A preset spawn graph in config bounds what each preset may spawn.
- **Providers are plugins.** A provider plugin contributes a model adapter, its env schema fragment, and a check that verifies entered credentials. zarg-router and OpenRouter are the first two provider plugins; both use the OpenRouter-wire adapter (`/chat/completions`), ported from zarg v1. An Anthropic SDK provider can come later as another plugin.
- Decisions (choice, yes/no, score with probabilities and confidence) are a service backed by zarg-router's `jevk5` over `POST /systemone`, with a structured-output fallback.
- Environment and secrets go through varlock's programmatic API. Secrets are stored with varlock's device-bound encryption. Sensitive values never reach a model.

## Packages

```
packages/
  model/      @zarg/model      Env, config loader, Secrets, Model service, the provider contract,
                               and the OpenRouter-wire adapter that provider plugins reuse
  provider-zarg-router/  @zarg/provider-zarg-router   provider plugin (warm-up, /systemone capability)
  provider-openrouter/   @zarg/provider-openrouter    provider plugin
  decisions/  @zarg/decisions  Decisions service
  kernel/     @zarg/kernel     Bun Worker kernel and its RPC bridge
  rlm/        @zarg/rlm        Rlm service: presets, spawn graph, scope, the turn loop
```

`@zarg/plugin` changes: plugin `tools` become plugin `services` (see "Plugin services").

## RLM

### Spec

```ts
Rlm.exec(spec): Effect<A, RlmError>
spec = {
  task: string,
  preset: string,                // selects layer, prompt stance, default budget, model role
  scope: Scope,                  // the bounded domain this RLM may see and touch
  budget?: Partial<Budget>,      // can lower the preset's budget, never raise it
  result: Schema<A>,             // the final answer must decode to this
}
Scope  = { graph?: { focus: string[], k: number }, paths?: string[], kind?: string }
Budget = { turns: number, tokens: number, wallMs: number }
```

### Presets and the spawn graph

A preset is a named bundle of `layer`, `spawns`, `role` (which model role runs it), prompt stance, and default budget. Presets live in config.

```toml
[rlm]
max_depth = 4
max_concurrent = 8

[rlm.presets.driver]
layer  = ["Graph", "Gherkin", "Inquire", "Fs:read", "Decisions", "Rlm"]
spawns = ["research", "driver"]
role   = "driver"
budget = { turns = 25 }

[rlm.presets.sync]
layer  = ["Graph", "Fs", "Sh", "Verify", "Agenda", "Decisions", "Rlm"]
spawns = ["implement-card", "research"]
role   = "sync"
budget = { turns = 40 }

[rlm.presets.implement-card]
layer  = ["Graph", "Fs", "Sh", "Verify", "Rlm"]
spawns = ["research"]
role   = "sync"
budget = { turns = 25 }

[rlm.presets.research]
layer  = ["Graph", "Fs:read", "Decisions", "Rlm"]
spawns = ["research"]
role   = "driver"
budget = { turns = 15 }
```

- The host checks every `Rlm.exec`: the parent's preset must list the child's preset in `spawns`. Otherwise the call fails with `RlmError{kind: "spawn"}`.
- A child gets its preset's full layer, whether that is wider or narrower than its parent's. The rule "the driver never edits code" holds because the driver preset cannot spawn a preset that writes code.
- `max_depth`, `max_concurrent` and budgets are host-side. No code in a cell can change them.
- `Decisions` can choose the preset for a piece of work (classification), and the RLM then spawns that preset.

### Scope narrowing

The RLM's runtime is built from its layer narrowed to its scope:

- `Graph` returns only nodes within `k` hops of `scope.graph.focus`.
- `Fs` and `Sh` resolve only paths under `scope.paths`.
- Plugin services refuse writes to nodes outside the scope. The refusal message tells the RLM to hand the work up or out with `Rlm.exec`.

### How one RLM runs

1. Resolve the preset, check the spawn graph, and apply depth and concurrency caps.
2. Build the RLM's runtime: `ManagedRuntime.make(layer narrowed to scope)`.
3. Build the manifest: every service in the layer, as TypeScript signatures generated from its Schemas plus one doc line per method.
4. Spawn a kernel (Bun Worker) with the manifest. The worker installs RPC clients for exactly those services.
5. Loop, at most `budget.turns` times:
   - Call `Model.stream` with a system prompt of stance, manifest and a scope summary, plus the messages so far.
   - Run each `exec({code})` call in the kernel.
   - Return the output (console lines plus return value, capped at 32 KB) as the tool result.
   - The RLM finishes by calling `yield* Rlm.done(value)`. The value must decode with `spec.result`.
6. When a budget runs out, give the model one final report turn. Its value must still decode.
7. Dispose the kernel and the runtime, and return the result to the parent.

### Folding

- A parent sees only a child's decoded result, never its transcript. This keeps each RLM's context small.
- Inside one RLM, only the latest few tool outputs are kept in full. Older ones are trimmed to a short head plus a note.
- The prompt stance tells every RLM to fold early: work outside its scope, or reading beyond a few files, goes to a child RLM.

### Inquire

`const answer = yield* Inquire.ask({question, options, allowOther, about})` suspends the cell.

- The RLM's run ends with an AG-UI interrupt (`RUN_FINISHED{outcome: interrupt}`, wired in 2b).
- The worker and the cell stay alive. `resume` settles the pending ask, and the same cell continues with the answer as a value.
- If core restarts while a cell is parked, the parked fiber is gone. The answer is then delivered as the next turn's message, and the fallback is logged.

2a defines the `Inquire` service interface and its suspend and resume mechanics. 2b provides the implementation that talks to AG-UI.

### Tracing

Every RLM has an id, a parent id, a preset and a scope. RLM start and end, cells, service calls, decisions and budgets are recorded as structured events. 2b streams them to clients as AG-UI activity.

## Kernel

- One Bun Worker per RLM. Workers are not shared between RLMs.
- A cell is TypeScript. Types are stripped with Bun's transpiler, then the cell is typechecked against the RLM's manifest. A cell that fails the typecheck is not run, and the compiler errors go back to the model. A service that is not in the layer is a compile error.
- The cell body runs as an `Effect.gen` body. Top-level `const`, `let`, `function` and `class` declarations persist as worker globals across cells.
- `import` is refused. Everything comes from services.
- Worker-side services are RPC clients generated from the service definitions. Calls cross to the host with Schema-encoded payloads and run in the RLM's host runtime. Typed failures come back as typed failures the cell can `catchTag`.
- **Timeout:** the deadline counts only time the cell runs in the worker. While a cell is yielded on a service call (a model turn, a child RLM, `Inquire.ask` waiting for the developer), the clock pauses. On timeout the worker is terminated and respawned, and its globals are lost. The model is told that this happened. A second death in a row ends the RLM with `RlmError{kind: "kernel"}`.
- Interrupting a cell also interrupts its host-side service fibers, including child RLMs.
- Output is capped at 32 KB per cell.
- The kernel runs with the scrubbed environment described in "Leak guard".

## Services

Each is a `Context.Service` with Schema-typed methods and a doc line per method. On the host it is the real implementation. In the kernel it is an RPC client.

| Service | Purpose | In presets |
|---|---|---|
| `Graph` | read, render, query, agenda (scope-narrowed) | all |
| plugin services, e.g. `Gherkin` | graph writes through the write pipeline | driver |
| `Fs` / `Fs:read` | files under the scope's paths | read: driver, research; read-write: sync, implement-card |
| `Sh` | run commands in the repo | sync, implement-card |
| `Verify` | run `mise run verify`, return the verdict | sync, implement-card |
| `Agenda` | raise an agenda item (e.g. a blocked card) | sync |
| `Inquire` | ask the developer | driver |
| `Decisions` | choice, yes/no, score | driver, sync, research |
| `Rlm` | `exec`, `done` | all |

### Plugin services

The plugin contract's `tools: Tool[]` becomes `services: PluginService[]`. A plugin service is a set of Schema-typed methods with doc lines. Every write method still runs through the write pipeline: decode, structural checks, lints, commit. `zarg tool call <plugin>/<method>` keeps working as a thin CLI over the same methods, so the phase 1 skills do not break.

## Providers

A provider is a plugin contribution:

```ts
provider: {
  name: "openrouter",
  schema: "./openrouter.env.schema",      // its env schema fragment
  adapter: openRouterWire({ dialect: "openrouter" }),
  verify: (values) => Effect<void, ProviderRejected>,   // e.g. GET /models with the key
  warm?: (ref) => Effect<void, ModelError>,              // zarg-router: POST /admin/warm
}
```

- `Model` routes a `provider:model` reference to the provider plugin named `provider`.
- **Login fields come from the schema.** `Env.fields(provider)` returns the items of the provider's schema fragment: name, type and validation, default, description, and whether it is `@sensitive`. A login form renders one field per item. Sensitive fields hide input. A value that fails its schema type is refused locally before `verify` is called (UX-0029).
- **Login:** values that pass the schema go to `verify`. On success, sensitive values are stored with `Secrets.set` (encrypted on this device) and non-sensitive values in `~/.config/zarg/.env.local` as plain text, then `Env.reload` runs (UX-0027). On rejection nothing is stored (UX-0028).
- **Logout** removes the provider's stored values with `Secrets.remove` (UX-0032).
- The `/login` and `/logout` commands and the driver's "login or another model" inquiry (UX-0030, UX-0031, UX-0033) are built in 2b on these operations.

## Model

```ts
class Model extends Context.Service<Model, {
  readonly stream: (req: ModelRequest) => Stream<StreamEvent, ModelError>
  readonly info: (ref: ModelRef) => Effect<ModelInfo, ModelError>
  readonly warm: (ref: ModelRef) => Effect<void, ModelError>
}>()("@zarg/model/Model") {}

StreamEvent = text{delta} | reasoning{delta} | toolCall{call} | usage{usage} | done{finishReason?}
```

Ported from zarg v1 (`packages/providers/src/stream-effect.ts`, `serialize.ts`):

- The SSE parser, tool-call assembly by index, `reasoning_content` and `reasoning`, and in-stream `error` frames turned into failures.
- `finishReason` is absent when the provider does not say. It is never defaulted.
- Retries on network errors, 429 and 5xx, honouring `Retry-After`, up to 3 attempts. An idle timeout between chunks. A first-output watchdog that also covers zarg-router's `: warming` comments.

New in v2:

- Retries and timeouts wrap every transport, not only the fetch path.
- `warm(ref)` calls zarg-router's `POST /admin/warm` before the first turn on a router model.
- Context window, output cap and reasoning efforts come from the provider's `/models` row. There are no placeholder limits.
- Reasoning is requested through OpenRouter's `reasoning{effort}`. zarg-router's `X-ZargRouter-Reasoning` header is recorded.
- An output-token cap per role. A turn that hits the cap on reasoning alone is continued once with a doubled cap.

## Decisions

```ts
decide(req: { state: string, questions: Record<string, Choice | Noul | Score> })
  : Effect<Record<string, Answer>, DecisionError>
Answer = choice + probabilities + confidence | score + legend + probabilities + confidence | noul answer + confidence
```

- The `decision` role's model is used. When its `/models` row advertises the `systemone` capability, the call goes to `POST {base_url}/systemone`.
- Otherwise the fallback asks the `driver` role's model for strict JSON-schema output (a probability per option), with one independent context per question and no tools.
- Tool support is read strictly from `supported_parameters`. zarg-router does not advertise `tools` yet; the router is being fixed to advertise it for models whose backend has a tool-call parser.
- Limits follow JEV: 1 to 8 questions, 2 to 16 choice options, 2 to 10 score levels, a 30-second deadline.
- Every call is logged with latency, transport, model and confidence.

## Config

Files: `~/.config/zarg/config.toml`, then `./.zarg/config.toml`. (`~/.zarg/` belongs to zarg v1 and is not read.) Tables merge. Validated with Schema, and unknown keys are an error.

```toml
[providers.zarg-router]
base_url = "${ZARG_ROUTER_URL:-http://localhost:11435/api/v1}"

[providers.openrouter]
base_url = "${OPENROUTER_URL:-https://openrouter.ai/api/v1}"
api_key  = "${OPENROUTER_API_KEY}"

[roles]            # model per role; nothing is shipped by default
driver   = "zarg-router:deepseek-v4.1-flash-exl3"
sync     = "zarg-router:deepseek-v4.1-flash-exl3"
decision = "zarg-router:jevk5"
```

- `${VAR}` and `${VAR:-default}` expand anywhere in a string value, once, in the config loader, before validation. `$${` is a literal `${`.
- A missing variable with no default fails with the variable name and the config key.
- A role with no model fails with the exact key to set. 2b turns this into an inquiry on first run.
- The resolved config is never logged as a whole.

## Environment and secrets (varlock)

### Env

```ts
class Env extends Context.Service<Env, {
  readonly get: (name: string) => Effect<string | Redacted<string>, EnvError>
  readonly sensitive: ReadonlyArray<{ name: string, value: Redacted<string> }>
  readonly reload: Effect<void, EnvError>
  readonly fields: (provider: string) => Effect<ReadonlyArray<EnvField>, EnvError>  // login form items
}>()("@zarg/model/Env") {}
```

The live layer calls varlock's programmatic `load()` at core startup and reads the resolved graph. Values of `@sensitive` items come back as `Redacted`.

### Schema files

- A committed root `.env.schema` imports provider and plugin fragments with `@import(...)`.
- Each provider plugin ships its fragment as `.env.schema` at its package root (varlock only imports `.env.*` files) and declares its variables there (`@required`, `@sensitive`, `@type`). The repo's root `.env.schema` imports each provider package directory, then `~/.config/zarg/` (`allowMissing`). Later imports win, and the root folder's own `.env.local` wins over all imports, so the root schema holds no defaults.
- `@required` on a provider nobody uses only marks that item with an error; loading does not fail. zarg checks item errors only for providers its roles use.
- Process environment variables override file values (varlock's precedence) and keep the schema's sensitivity.
- Plugins that need secrets ship fragments the same way.
- User values live in `~/.config/zarg/.env.local`, and project values in a gitignored `.env.local`. The project overlays the user.

### Secrets

```ts
class Secrets extends Context.Service<Secrets, {
  readonly set: (name: string, value: Redacted<string>) => Effect<void, SecretError>
  readonly has: (name: string) => Effect<boolean, SecretError>
  readonly remove: (name: string) => Effect<void, SecretError>
}>()("@zarg/model/Secrets") {}
```

- `set` pipes the value to `varlock encrypt` on stdin (varlock has no programmatic encrypt) and stores the resulting `NAME=varlock("local:...")` line in `~/.config/zarg/.env.local`, then calls `Env.reload`. Plaintext secrets are never written to disk.
- Loading uses `internal.loadVarlockEnvGraph` (the loader varlock's CLI uses; the plain loader lacks the `varlock()` resolver). It sits under varlock's `internal` export, so it is pinned to varlock 1.20.0 and covered by tests.
- `Secrets` is a host service. It is in no RLM preset's layer.
- The `/login` flow is captured as UX-0026..UX-0033. Its operations are in "Providers"; its commands and inquiry are built in 2b.

### Leak guard

1. Kernel Workers and `Sh` subprocesses get an environment with every `@sensitive` variable removed.
2. Every service result and every piece of `Sh` output is scanned for sensitive values. Each one found is replaced with `<redacted:NAME>` before it reaches a model, a log or an AG-UI client.
3. `Fs` refuses to read `.env*` files other than `.env.schema`.
4. Error messages never contain sensitive values.

## Errors

All errors are tagged. Errors are values an RLM can handle.

- `ModelError`: `transport` (retried), `timeout`, `first-output`, `stream`, `limits`.
- `DecisionError`: `unavailable` (then the structured fallback), `deadline`, `malformed`.
- Cell failures (typecheck, runtime exceptions, service errors) go back to the model as tool output. They never end the RLM by themselves.
- `RlmError`: `budget`, `result` (the final value failed to decode), `model`, `kernel` (two worker deaths in a row), `spawn` (not allowed by the spawn graph).
- `EnvError`, `ConfigError`, `SecretError`: name the variable or key and the file. They never contain sensitive values.

## Testing

No test in `mise run verify` touches the network.

- `@zarg/model`: a fake SSE server replays recorded streams: tool-call assembly, reasoning, an in-stream error, `: warming` comments, 429 with `Retry-After`, idle timeout, first-output timeout, limits from a `/models` row.
- `@zarg/decisions`: native `/systemone` against a fake server, and the structured fallback against a stub `Model`.
- `@zarg/kernel`: declarations persist across cells, `import` is refused, a service missing from the manifest is a compile error, timeout and respawn, interruption reaching host fibers.
- `@zarg/rlm`: a stub `Model` replays scripted `exec` calls. It covers result decoding, budget exhaustion with the final report turn, the spawn graph (driver to implement-card refused, sync to implement-card allowed), scope narrowing, folding (the parent sees only the child's result), and `Inquire` suspend and resume.
- Config and env: `${VAR}` expansion, defaults, a missing variable, a `@sensitive` value decoding as `Redacted`.
- Leak guard: with a fake `@sensitive` `OPENROUTER_API_KEY`, `Sh.run("env")`, `Fs.read(".env.local")` and a service that echoes the value all return nothing or `<redacted:OPENROUTER_API_KEY>`.
- `mise run smoke` (outside `verify`): one driver RLM runs one cell against a real zarg-router model.

## Build order

1. Toolchain: mise tasks call `mise x -- bun` so they run the pinned bun even when a global bun is first on PATH. (Spike done: see Environment and secrets.)
2. `Env`, config loader, `Secrets`.
3. `@zarg/model`: provider contract and the OpenRouter-wire adapter; then the zarg-router and OpenRouter provider plugins.
4. `@zarg/decisions`.
5. `@zarg/kernel`.
6. Plugin tools become plugin services; `zarg tool call` keeps working.
7. `@zarg/rlm`: presets, spawn graph, scope, folding, `Inquire` interface.
8. `mise run smoke`.

## Out of scope

- AG-UI wiring, threads, focus, the driver and sync loops: 2b.
- What the sync agent owns in code: 2c.
- The Anthropic SDK adapter.
- A Linux keychain plugin for varlock.
- Kernel heap snapshots. Kernel state is scratch. The truth lives in the graph.
