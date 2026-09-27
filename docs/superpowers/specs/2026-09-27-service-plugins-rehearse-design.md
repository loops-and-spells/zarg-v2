# Service plugins, and rehearse as one

Date: 2026-09-27
Status: direction approved in conversation, pending written review
Parents: `docs/superpowers/specs/2026-09-27-plugin-runtime-sdk-design.md` (the runtime, powers, grants), `docs/superpowers/specs/2026-09-27-rehearse-design.md` (what rehearse does)
Intent: `intent/zarg.md` ("Plugins decide what goes on the graph"; plugins, continued)

## Outcome

Rehearse leaves the core and becomes `@zarg/plugin-rehearse`, a first-party plugin in its own locked-down process like Gherkin. To make that possible, plugins gain what rehearse needs, in a form any plugin can use:

- **Typed plugin contracts and `pluginDependencies`**: a plugin depends on other plugins' contracts (Effect service tags), loads only when they are loaded and match, and calls their contract methods typed.
- **A `service` archetype**, for plugins that do work (run agents, test, report) rather than define graph types or model providers.
- **New powers**: `Models`, `Decisions` and `Agents`, each granted like the others.
- **Agents that draw themselves**: a plugin's agents show in the agents pane with their own row and their own body (history, tables in tabs, actions on selected rows).
- **Findings the developer picks**: plugins report findings; the developer selects them in a table and applies them; the driver changes the graph. Nothing is applied on its own unless the plugin's `auto_apply` setting says so (off by default).
- **Plugin slash commands**: `/rehearse` comes from the plugin's manifest, not the core.

The core keeps one thing plugins must never do themselves: opening the driver's graph write gate and committing.

## Plugin contracts and pluginDependencies

Dependencies are typed: a plugin depends on another's **contract**, an Effect service tag, never on a name string.

- **A contract** is a code-free subpath of the plugin's package (`@zarg/plugin-gherkin/contract`): the plugin's name and the Schemas of the methods other plugins may call, made with `pluginContract`, which returns an Effect `Context.Service` class:

  ```ts
  export class Gherkin extends pluginContract("gherkin", {
    stories: { params: StoriesParams, success: StoriesResult },
    step: { params: StepParams, success: StepView },
  }) {}
  ```

  The plugin's own `definePlugin` uses the same method specs, so plugin and contract cannot drift.
- **A dependent** lists contracts and yields them like any service:

  ```ts
  import { Gherkin } from "@zarg/plugin-gherkin/contract"
  definePlugin({ name: "rehearse", archetype: "service", pluginDependencies: [Gherkin], make: Effect.gen(function* () {
    const gherkin = yield* Gherkin // gherkin.stories(...), gherkin.step(...), typed
  }) })
  ```

  An unknown plugin or method is a compile error. `pluginDependencies` accepts only contract tags.
- **At runtime** the SDK builds each contract's service on the `Plugins.call` power, encoding params and decoding results with the contract's Schemas (as the kernel does for services).
- **Manifest:** `zarg plugin build` writes `pluginDependencies: [{ name, methods }]`, where `methods` is a digest of the contract's JSON Schemas.
- **Loading:** the host loads plugins in dependency order. A plugin loads only when every dependency loaded (installed, granted, enabled) and its manifest matches the digest; otherwise the agenda says why: "Plugin `rehearse` needs `gherkin`, which is not loaded (not granted)", or "was built against a different `gherkin` (stories changed); rebuild it".
- **Cycles:** plugins in a dependency cycle do not load; the agenda names the cycle.
- **At runtime:** a dependency that is disabled (three restarts in ten minutes) disables its dependents with it, reported the same way.
- **Calling:** `Plugins.call(name, method, params)` reaches only declared dependencies, and only the methods their contract lists: a contract is the plugin's public read surface. Writes and agent tools never go plugin to plugin; graph writes go through the write pipeline from an agent.
- **Imports:** the rule that no package imports a plugin gains one exception: `/contract` subpaths. The import test also checks a contract module is code-free (Schemas and the tag, no plugin code), so a contract never pulls a plugin into another plugin or the core.
- **Grants:** a dependency's grant is its own; depending on a plugin never widens either plugin's scopes.

## The service archetype

- `archetype: "service"` joins `graph` and `provider`. A service plugin declares no graph node types. It may have agents, bodies, findings, an agenda and slash commands.
- The TUI's plugin setup (sub-project 5) lists service plugins with their config.

## New powers

Each is declared in `scopes` (or `optional`), granted like the others, and bounded by YOLO the same way.

| power | scope | what the host does |
|---|---|---|
| `Decisions.decide(req)` | `decisions: true` | runs the request on the configured decision model |
| `Models.complete({ role, messages, outputSchema?, maxTokens? })` | `models: ["rehearse"]` (the roles it may use) | runs the configured model for that role; tokens count against the plugin and show in its agents |
| `Agents.start({ id, parent?, title, task })`, `Agents.status({ id, progress?, text? })`, `Agents.step({ id, text })`, `Agents.end({ id, ok, message? })` | `agents: true` | shows the plugin's agents in the thread's agents pane, in the plugin's own activity stream (a driver item starting over leaves them); `step` lines are the agent's history (redacted, in the transcript) |
| `Agenda.changed()` | (a plugin with an `agenda` method) | re-reads the plugin's agenda and wakes the driver when it waits on nothing, or only on zarg's own what-next question |
| `Plugins.call(name, method, params)` | `pluginDependencies` | the transport under contract services; see above |

Existing powers cover the rest: `Files` with declared `fs` scopes (rehearse: `.zarg/rehearse/**`), `Config` (the plugin's settings), `Graph` (read).

## Agents that draw themselves

- **Row:** `Agents.status({ progress: { done, total }, text })` draws the agent's row: the bar from `progress`, `text` in place of turns. (The core's `status` activity event, built for rehearse, becomes this power's host side.)
- **Body:** the host calls the plugin's reserved method `body({ agent })` when the developer opens an agent (Enter or a click on a leaf, as today). It returns parts:
  - `{ kind: "history" }`: the agent's own step lines, drawn like an RLM's history;
  - `{ kind: "lines", lines: [{ text, tone }] }`;
  - `{ kind: "tabs", tabs: [{ title, columns, rows: [{ id, cells }] }], actions: [{ id, label, key }] }`.
- **Actions:** the TUI sends `act({ agent, action, rows })` to the plugin (through `POST /threads/:id/agents/:agent/actions/:action`) with the selected row ids.
- **Keys in a body:** ↑↓ moves in a table, Space selects, Tab switches tabs, an action's key runs it (rehearse: `a` apply, `d` dismiss), Esc goes back; a click selects a row, and action buttons are clickable. A pending question still takes its keys.
- RLMs keep their built-in history body; nothing changes for them.

## Findings the developer picks

- A plugin that reports findings answers the reserved method `finding({ id })` with `{ card, chosen, hash, notes }`: which card it is about, whether the developer chose it (or `auto_apply` did), and the card text it was judged on.
- **Choosing:** the plugin's `act` for `apply` marks findings chosen, lists them on its `agenda`, and calls `Agenda.changed()` so the driver takes them up. `dismiss` hides them; a rerun keeps them hidden while the card is unchanged.
- **The driver's side stays in the core**, for every plugin: `Findings.take({ plugin, finding })` asks the plugin's `finding`, refuses one not chosen or stale (the card is gone, or its text hash changed), and opens graph writes for that card, its states and what the fix adds, until the next question. `Findings.resolve({ plugin, run, applied, dismissed })` commits exactly the touched node files in one commit and tells the plugin (`resolved({ run, ids })`).
- `Rehearse.fix` and `Rehearse.resolve` become these; `Rehearse.run` becomes the plugin's agent method `run`.

## Plugin slash commands

- The manifest gains `commands: [{ cmd, desc, method, arg }]` (the TUI's slash-command table shape). The TUI builds its table from the core's own commands plus every loaded plugin's.
- A plugin command calls the plugin method through `POST /plugins/:name/commands/:cmd` with the parsed arguments; the method's result `{ notice }` is shown.
- `/rehearse [edge-pair|teleport] [focus=…]` moves to the rehearse plugin's manifest.

## Rehearse as a plugin

- `packages/plugin-rehearse` (`@zarg/plugin-rehearse`), first-party, `archetype: "service"`, `pluginDependencies: [Gherkin]` (from `@zarg/plugin-gherkin/contract`).
- Scopes: `decisions: true`, `models: ["rehearse"]`, `agents: true`, `fs: { read: [".zarg/rehearse/**", "intent/**"], write: [".zarg/rehearse/**"] }`.
- Config (`[plugins.rehearse]`): `auto_apply = false`, the screen thresholds (`feel_below`, `fail_at`, `fork_below`, `seam_below`, `real_keep`, `real_drop`), `in_flight`.
- Methods: `run` (agent tool and `/rehearse`), `agenda`, `body`, `act`, `finding`, `resolved`.
- Everything in the rehearse design keeps working: edge-pair and teleport stories (now through the `Gherkin` contract: `gherkin.stories`, `gherkin.step`), personas from the intent, the decision-model screen, diagnosis, consolidation, the report, the record and resume, one run at a time, progress rows, tester history.
- New, from the conversation: the tester's body is its history on top and its findings below in **Feedback** and **Likes** tabs; the run's body is the same table over all testers; `a` applies the selected findings, `d` dismisses them.
- The core's `packages/core/src/rehearse/` goes away, except that the findings gate moves to `packages/core/src/findings.ts`.

## Errors and safety

- A plugin never opens the write gate, never writes the graph and never commits: only the driver, through `Findings.take`, after the developer chose (or `auto_apply`).
- Plugin output reaching the driver (findings, the report, agenda text) is untrusted text, as sub-project 4 says: the driver prompt marks it so.
- `Models` and `Decisions` calls count against a per-plugin budget (tokens and calls per hour, a setting); past it, calls fail with `BudgetExceeded`.
- A dependency missing or disabled is never silent: the agenda says which plugin and why.

## Testing

No live model in `verify`: the host serves scripted `Decisions` and a stub model to plugins in tests.

- **Dependencies:** order, a missing dependency, a digest mismatch, a cycle, a dependency disabled at runtime taking its dependents with it; `Plugins.call` refused for an undeclared plugin and for a method outside the contract; a contract's service is typed (a compile-time test file with `@ts-expect-error` on an unknown method); the import test allows `/contract` subpaths and fails one that carries plugin code.
- **Powers:** each refused without its scope; `Models` limited to declared roles; tokens counted; YOLO passes declared scopes only.
- **Agents:** a plugin's agents show in the pane in their own stream, a driver reset leaves them, `status` draws the row, `step` lines are the history.
- **Bodies:** the TUI draws history, lines and tabs; select, tab, apply, dismiss; a pending question keeps its keys.
- **Findings:** `take` refuses unchosen and stale findings and scopes writes to the finding's card; `resolve` commits only touched files; `auto_apply` on and off.
- **Slash commands:** a plugin command appears in the table and calls its method.
- **Rehearse:** its existing tests move to the plugin package and pass there, plus the tables and apply/dismiss.

## Out of scope

- Stage 2 (testers driving the running product on VMs): the VM plugin will depend on nothing here beyond `service` plugins and the powers above.
- Plugin-to-plugin writes.
- Third-party service plugins' consent UX (sub-project 5).
