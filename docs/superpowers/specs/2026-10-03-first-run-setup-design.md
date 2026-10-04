# First-run setup: providers, then a default model

Date: 2026-10-03 · Status: approved design (the operator), pending spec review. Terms: `docs/taxonomy.md`

## Problem

- **zarg works only in its own repo.** In any other project, `zarg` fails with `no model for role "driver"; set roles.driver`. Roles live only in zarg-v2's `.zarg/config.toml`, and env is loaded only from the project's `.env.schema`, so a new project sees neither your models nor your logins.
- **Nothing asks you to set anything up.** The pieces exist but are unused: `Env.fields` (forms from the schema), `WireClient.verify` and `models`, and `Secrets.set` (varlock device-bound encryption). Provider login and model setup are planned but not built: scenarios UX-0026..0039, now S-0026..0039 (`2026-09-29-cards-vs-code-audit.md:51`).
- **Without a driver, things fail quietly.** A plugin's `models.complete` falls back to the stub model's name (`core/src/live.ts:374`). Every driver run fails with a config error.

## What this changes

- **Your models are yours, set once:** in `~/.config/zarg/`, for every project.
- **A first run asks:** set up or log in to a provider, then pick the **default model**. Every role with no model of its own uses it.
- **`/login` and `/models`:** reopen the same Setup view later. This ports v1's `/models`, reduced to the default model.

## Settings and fallback

- **`roles.default = "provider:model"`** in `~/.config/zarg/config.toml`. A project's `.zarg/config.toml` overrides any role, `default` included (the project wins, as today).
- **One lookup:**
  - `roleModel(config, role)` returns `roles[role]`, else `roles.default`, else `NotSetUp`.
  - It replaces every fallback in use today: `roles[req.role] ?? roles.driver ?? STUB_MODEL` (`live.ts:374`), the decision fallback (`decisions/src/index.ts:163-164,230`), the reconcile gate (`core/src/phases.ts:61`), and the RLM's role check (`rlm/src/rlm.ts:193`).
  - The stub model is never used silently.
- **Providers:**
  - Login writes each value of the provider's `.env.schema` fragment. A `@sensitive` one goes through `Secrets.set` (`varlock encrypt`), and others through `Secrets.setPlain`, all into `~/.config/zarg/.env.local`.
  - It also writes `[providers.<name>]` (its `base_url = "${…}"` and the like, as the provider's template says) into `~/.config/zarg/config.toml` when that section is missing.
  - A project's own `[providers.<name>]` still wins.
- **Env in any project:** `Env.layer` loads, in order:
  1. the providers' schema fragments (from zarg's own install: each `Provider.schemaFile`);
  2. `~/.config/zarg/` (its `.env.schema` and `.env.local`, when present);
  3. the project's `.env.schema`, when it has one.

  Later entries win, and process env wins over files (varlock's rule).
- **Config fix:** `config.ts` accepts the `[plugins]` and `[agents]` sections that `live.ts` reads (today it rejects them).
- **Writing config:**
  - A TOML-preserving edit of only `roles.default` and `[providers.<name>]`. Comments and other sections stay.
  - The write is atomic (temp file, then rename).

## The Setup view (core-served)

The core serves a view named `setup` from its own state, as plugin views are served. The TUI only renders it, and a web client would get it without changes.

**Sections:**
- **Summary:** "N providers ready · default: `<model>`" or "default: none".
- **Providers** (table):
  - One row per installed provider (`Model.layer`'s list: zarg-router, openrouter).
  - Its state: `✓ reachable · N models`, `◇ not set up` (a required value missing), or `✗ <why>`. The reason comes from `verify`: 401/403 → "the key was refused"; a refused connection → "is it running?"; 404 → "check its URL".
  - Action `login` (`⏎`) opens the form.
- **Login form:**
  - One input per variable in the provider's fragment, from `Env.fields`: its description, whether it is required, and its current non-secret value pre-filled (openrouter's URL).
  - A `@sensitive` variable's input is masked. This is a new view feature: an action's input can say `sensitive: true`.
  - Saving writes the values, runs `env.reload`, then `verify` (`GET /models`).
  - On failure the row shows the reason, and the values stay saved for you to correct.
- **Default model** (table, `search: true`):
  - Every model of every reachable provider (`Model.list`), as `provider:model`, with its context length and capabilities (`ModelInfo`).
  - Action `default` (`⏎`) writes `roles.default`.

**When it opens:**
- **On its own:** when the core starts, or a client attaches, and `roleModel(config, "driver")` is `NotSetUp`, or its provider is unreachable. It is a sheet over the agent grid.
- **On demand:** `/login` opens it at the providers, `/models` at the default model. These are new built-in slash commands, routed like `/reconcile`.
- **After a default that works:** the view closes, and zarg's conversation starts on that model without a restart (the config reloads in place).

**Core routes:**
- `GET /setup`: providers, states, models.
- `POST /setup/login {provider, values}`: values in the body; sensitive ones are wrapped as `Redacted` on arrival.
- `POST /setup/default {model}`.

The view's actions use these routes through the same act path as any view.

## Before setup is done

- **agent-zarg** loads. Its runs wait ("setup needed" in the status line) instead of failing with `no model for role`.
- **A plugin's `models.complete`** fails with `no model for role "<role>" (set a default with /models)`.
- **Reconcile** stays off with "set a default model with /models".
- **Decisions** fail as today, with the same pointer.

## Secrets

- A secret never appears in a view's data, an event, a log or a thread.
- The form's sensitive values travel once, in the act's body, and are wrapped as `Redacted` on arrival.
- Act logging redacts every input the layout marks sensitive.
- Tests use variable names unique to each test.

## Out of scope

- Per-role overrides in `/models`; set them in config by hand for now.
- v1's presets, llm-stats scores and role prompts.
- OAuth and device login. Today's two providers need only key and URL fields.
- Warming a local model on pick.

## Tests

- **model:**
  - `roleModel`: a role's own model, then `roles.default`, then `NotSetUp`.
  - `Env.layer` in a project without `.env.schema` sees `~/.config/zarg/` values and the provider schemas.
  - The config writer keeps comments and other sections, and is atomic.
  - `[plugins]` and `[agents]` load.
- **core setup service, with stub providers:**
  - A login saves values (secret ones encrypted, plain ones plain) and verifies.
  - A failed verify reports its reason.
  - A pick writes `roles.default`.
  - The view opens when the driver resolves to `NotSetUp`.
  - `/login` and `/models` open it.
  - After a pick, a driver run uses that model.
- **view:**
  - A `sensitive` input is masked when drawn.
  - Its value never appears in the act log.
- **view-tui:** the Setup view renders its providers, form and model list.
- **End to end:** a temp project and a temp user dir: nothing set → login (stub provider) → pick a default → a driver run uses it.
