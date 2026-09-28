# Agent Guide

Rules for any agent (Claude, Codex, etc.) working in this repo.

## Toolchain

- **mise** manages every tool version. `mise.toml` is the source of truth.
- **bun** is the JavaScript runtime, package manager, test runner, and script runner.

## Layout

Monorepo. Every module lives in its own package under `packages/<name>/`.

```
mise.toml        # tool versions + monorepo root (config_roots = packages/*)
package.json     # bun workspaces = packages/*
packages/<name>/
  mise.toml      # this package's tasks (build, test, dev, ...)
  package.json   # name: @zarg/<name>
```

- One package = one module. No cross-package imports through relative paths; depend on the package by name (`"@zarg/<name>": "workspace:*"`).
- Tool versions live only in the root `mise.toml`. Package `mise.toml` files define tasks only.
- One `bun.lock` at the root. Run `bun install` from the root.

## Packages

- `packages/graph` (`@zarg/graph`): JSON graph store under `.zarg/graph`: snapshot, queries, diff.
- `packages/highlight` (`@zarg/highlight`): syntax highlighting as data, no dependencies: `highlight(lang, source)` → lines of spans with token kinds (keyword, id, comment, title, flow, string, number); platforms map kinds to their theme. Knows zarg's Gherkin; `@zarg/markdown` draws those fences with the host's colours.
- `packages/tokens` (`@zarg/tokens`): the design language: token keys (surfaces, text, intent, identity, severity, status, syntax), a platform-free `Theme` (keys to colour names, aliases resolved once) over a per-platform `Palette` (terminal truecolor, 256, 16; web dark, light), both Effect services (`Palette.on(platform)`, `Palette.terminal` from `ZARG_THEME_COLORS` / `COLORTERM` / `TERM`; `Theme.layer`). Plugins name intent, identity and severity keys only.
- `packages/frontmatter` (`@zarg/frontmatter`): the parsable data at the top of a Markdown file (a YAML subset, no dependencies, so it runs in the plugin sandbox): `parse(md) → { data, body }`, `stringify`. Intents keep `personas` and `next` there, plans `card`, `hash`, `title`.
- `packages/bm25` (`@zarg/bm25`): Okapi BM25 over short texts (`bm25(docs).score(query)`, `rank`), with a light stemmer; no dependencies.
- `packages/entities` (`@zarg/entities`): references to any plugin's data (`<plugin>/<kind>:<id>[@<version>]`), canonical versions, the entity shapes; no dependencies (runs in the sandbox). Plugins declare kinds (`entities` in `definePlugin`, with a tone and glyph) and serve them; graph node kinds are served for free; the host routes every ref to its one owner; plugins read them with the `Entities` power (scope `entities: { read, command }`), RLMs with the `Entities` service (typed per kind, `Entities:read` in the driver, plan and research presets); a table column with `ref: true` shows labels the core resolves.
- `packages/plugin` (`@zarg/plugin/server`, `@zarg/plugin/runtime`): the plugin runtime (each plugin in its own locked-down Bun process with `ses`, powers served by the host), grants (`~/.config/zarg/grants.json`), `PluginHost` and the write pipeline. Plugins load only through it; a test fails if another package imports a plugin.
- `packages/plugin-sdk` (`@zarg/plugin-sdk`, `@zarg/plugin-sdk/tools`): `definePlugin`, `defineView` and the power services plugins yield (`Secrets`, `Http`, `Files`, `Graph`, `Config`, `Agents`, `Views`, `Surfaces`, `Attention`, `Conversation`, …); a plugin declares `surfaces` (where its views show; a `card` is how an agent looks in the grid) and marks tables `review: true` for the review queue; manifests, the checked build and `testPlugin`.
- `packages/plugin-gherkin` (`@zarg/plugin-gherkin`, contract `@zarg/plugin-gherkin/contract`): atomic Gherkin user action graph (states, cards, personas: who acts in each card, `by`, and journeys: named groups a card can be in, any number, `in`); its Journeys view is a nav item.
- `packages/plugin-backlog` (`@zarg/plugin-backlog`, contract `@zarg/plugin-backlog/contract`): feedback (`backlog/feedback` entities, one committed file each under `.zarg/feedback/`), tied to the version of the entity it is about: stale once that changes. Its Feedback nav view is the triage hub: a journey's open feedback as on/off rows (the agent's first call, the operator flips with space). Plans (`backlog/item`, `.zarg/backlog/`) live on its Backlog nav view, a kanban (Backlog, Ready, Running, Review, Done; each lane scrolls and folds with z/Z; ⇧←→ moves a card; ⏎ opens the drawer). The core's Planner (`core/src/planner.ts`) applies a Ready plan's gherkin changes through the write pipeline, commits exactly those nodes and wakes reconcile; a landed pass moves it to Review.
- `packages/agent-triage` (`@zarg/agent-triage`, plugin name `triage`): the Triage Agent. For each journey in the Feedback view it proposes card changes for the feedback that is on (the `driver` model role; each proposal dry-run through gherkin's `dryRun`), re-rehearses the journey over the accepted draft (rehearse `run` with `draft`, `file: false`) and drafts the plan the operator backlogs. The core wakes it when the backlog's or rehearse's agenda changes. Drafts never touch the graph until the Planner applies a plan.
- `packages/agent-host` (`@zarg/agent-host`): the contracts between the core and agents: the `Thread` the core serves, the `AgentHost` a trusted agent gets, `defineTrustedAgent`. A library, not an agent.
- `packages/agent-zarg` (`@zarg/agent-zarg`): zarg, the conversational agent: the driver loop on `main`, the write gate, what next. A trusted first-party agent (`"zarg": { "runtime": "trusted" }` in its package.json): the core loads it by path from zarg's own packages and starts it; without it the core still serves and says why.
- `packages/agent-rehearse` (`@zarg/agent-rehearse`, plugin name `rehearse`): testers roleplay the Gherkin journeys on the decision model (`/rehearse`; `journey` stories by default: edge-pair inside each journey, one story per handoff between journeys, lone cards alone; `edge-pair` over the whole graph and `teleport` on request) and file what they find as feedback with the backlog, on the card version they saw, with rehearse's own triage as the first call; its views only report (a rollup, and what each tester filed and where it stands). A sandboxed agent that depends on gherkin and backlog. `mise run calibrate:rehearse` tunes its thresholds (needs the decision model; ask first).
- Naming: `agent-*` agents, `provider-*` providers, `plugin-*` graph and service plugins. Agents run `trusted` (in the core, first-party only) or `sandboxed` (SES, any plugin).
- First-party plugins build to their `dist/` with `mise run build:plugins` (also the `build` task of `packages/plugin`, which tests and `mise run zarg` depend on); it records their hashes in `packages/plugin/src/server/first-party-hashes.ts`.
- `packages/cli` (`@zarg/cli`): the `zarg` CLI. `zarg [--thread <id>] [--focus <node>]…` opens the TUI (it starts a core as its child, or attaches to a running one); `zarg core start --headless`, `zarg core stop`, `zarg core status` manage a detached core; the other subcommands are graph tools. Run it with `mise run -q zarg -- <command>`. `mise run smoke:chat` runs one live driver item (needs the configured driver model; ask first).
- `packages/model` (`@zarg/model`): `Env` and `Secrets` (varlock), config loader, `Model` service, provider contract, OpenRouter-wire client.
- `packages/provider-zarg-router`, `packages/provider-openrouter`: provider plugins. Each ships its `.env.schema` fragment.
- `packages/decisions` (`@zarg/decisions`): `Decisions` service (JEV `/systemone`, structured fallback).
- `packages/kernel` (`@zarg/kernel`): yieldable service definitions, the manifest they generate, and the Bun Worker kernel that typechecks and runs cells.
- `packages/rlm` (`@zarg/rlm`): the RLM (unit of agency): presets and spawn graph, scoped core services (`Graph`, `Fs`, `Sh`, `Verify`, `Agenda`, `Inquire`), plugin tools as services, and the turn loop.
- `packages/core` (`@zarg/core`): `zarg-core`, one per project: hosts agents (it loads the trusted ones, like `agent-zarg`, and gives them `AgentHost`), threads and their logs (`.zarg/threads/`), the plugin host and grants, views, YOLO, and the plan and implement phases on the reconcile loop (`plan` and `implement` threads, findings on zarg's agenda); grants as the core's own prompts (`zarg.prompt` events, answered with `POST /prompts/:id`, popovers on every client); the AG-UI API on `.zarg/run/core.sock` (token in `.zarg/run/core.json`).
- `packages/client` (`@zarg/client`): attach to or start a core, the AG-UI client, and `reduce` (events → thread state, including each agent's view). Never imports `@zarg/core` or a `/server` subpath.
- `packages/view` (`@zarg/view`, `@zarg/view/react`): agent views, platform-free: the section schema and `defineView`, the AG-UI view reducer, the view behaviour (focus, tabs, rows, selection) and `useView`, input layers (`dispatch`: the key goes to the top layer that takes it), surfaces (`tile`, `panel`, `popover`, `sheet`, `card`, and `nav`: an item above the agents that opens the plugin's view, which the plugin fills on `act` "open"; each with its own typed config, checked with `surfacesProblem`); tables can declare `search: true` (a query ranks rows by BM25 over their cells and hidden `search` text) or `toggle: true` (rows on or off, space flips them through the plugin), and a table action can be `highlight: true` (it runs whenever the cursor lands on another row: a list whose choice fills the rest of the view), a `board` section is a kanban (lanes of cards; the view keeps each board's cursor and folded lanes), and a text can `follows` a table (it shows the text for the highlighted row) and sit `beside` it (a list and its detail side by side), and agents' key mappings per platform (`keys: { terminal, web }`, `key` for the terminal; a platform's reserved keys and a key twice where both would answer are refused). Imports no platform module (a test fails if it does).
- `packages/view-tui` (`@zarg/view-tui`): the terminal platform, drawn with the `Theme` from `@zarg/tokens` (`App` takes it; `zarg` picks the terminal palette from `ZARG_THEME_COLORS`, `COLORTERM`, `TERM`; plugins name tones, never colours) and no box in a box (sections are headed blocks): the agents rail (full height, left; glyphs only under 100 columns); the focus area rests on a paginated grid of agent cards (zarg's sheet open over it on arrival when no plugin agent works), and shows one agent's view, zarg's conversation or the review queue (every agent's `review` tables); `^k` opens the palette, `⇥`/Esc go back; the open agent's view in the tile area, zarg's message bar under it that opens into zarg's sheet over the tile area, grant popovers over everything in the core's first-in-first-out queue, and a renderer for every section kind. Surfaces: plugin panels at the tile area's edges (shell-scope ones one per plugin and two per edge, agent-scope ones with their agent; × or Esc closes one), plugin sheets and popovers, tiles a plugin opens during the operator's call; zarg's bar is agent-zarg's panel (without it: "zarg is not loaded"). Keys go through input layers: `alt+a` agents, `alt+v` the view, `alt+m` the bar (again: the sheet), `/` commands from anywhere, `g` the next agent asking for attention (◆ blinks until seen), Alt+arrows between panels; `x` archives a finished agent (with its children), `X` every finished one, and archived agents wait in a folded Archived row (`x` restores, `D` deletes for good). The core archives agents a restart stopped, and finished ones after `[agents] ttl` (default 24h; "off"). Never imports `@zarg/core` or a `/server` subpath. Web and native renderers come later as sibling packages.
- `packages/reconcile` (`@zarg/reconcile`): the reconcile loop every downstream phase runs (see `intent/zarg.md`): affected cards, per-card git worktrees, merge, verify with fixes, one commit per pass landed on your branch, findings; each pass is a durable Effect workflow (`.zarg/run/cluster.db`).

Design: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md`, `docs/superpowers/specs/2026-09-25-agent-runtime-design.md` and `docs/superpowers/specs/2026-09-26-core-driver-tui-design.md`.

## Secrets

- The root `.env.schema` declares every variable zarg reads (it imports the provider packages and `~/.config/zarg/`). Values live in gitignored `.env.local` files. Store secrets with varlock's device-bound encryption: `echo "$KEY" | mise x -- bunx varlock encrypt`.
- Never print, log or commit a secret value. In tests, use variable names unique to the test so a developer's real environment cannot override them or leak into output.

## Requirements

This repo's requirements live in its own zarg graph under `.zarg/graph`.

- Use the `zarg-drive` skill (`.claude/skills/zarg-drive/SKILL.md`) to refine requirements. It edits only the graph.
- Use the `zarg-implement` skill (`.claude/skills/zarg-implement/SKILL.md`) to make code match the graph when no zarg core is running (a running core plans and implements on its own). It edits only code and `.zarg/plans`.
- Never edit `.zarg/graph` files by hand. Change them through `zarg tool call`.
- Tag code that implements a card with a `// @card <id>` comment (for example `// @card UX-0003`).

## Tasks

mise orchestrates tasks across packages:

```sh
mise tasks ls --all             # list every task in the monorepo
mise //packages/<name>:test     # one task in one package
mise //...:test                 # the same task in every package
```

A task depends on another package's task with `depends = ["//packages/<other>:build"]`.

## Setup

```sh
mise trust
mise install
```

## Rules

- Run tools through mise (`mise x -- bun ...`). A globally installed bun can shadow the pinned one even inside `mise run`, so every task calls `mise x -- bun`, and tests spawn `process.execPath`, never a bare `bun`.
- Add or change a tool version only in `mise.toml`. Never document a version anywhere else.
- Use `bun`, never `npm`, `npx`, `yarn`, `pnpm`, or `node`. Use `bunx` in place of `npx`.
- Use `bun add` / `bun remove` to change dependencies. Commit `bun.lock`.
- Use `bun test` for tests and `bun run <script>` for package scripts.
- `mise run verify` typechecks and tests every package. It must pass before any commit.
- Define repeatable project commands as `[tasks]` in `mise.toml`, so humans and agents run the same thing (`mise run <task>`).
