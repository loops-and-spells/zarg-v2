# End-to-end suite: operator journeys against a new project, on the real models

Date: 2026-10-04 · Status: approved design (the operator), pending spec review.

## Problem

- **Nothing tests zarg the way the operator meets it.**
  - The one TUI test (`cli/test/tui.e2e.test.tsx`) renders the TUI in-process.
  - The core's stub mode (`ZARG_CORE_STUB`) swaps in scripted models inside the process, bypassing providers, setup and the router.
  - The smoke scripts (`smoke:chat`, `smoke:implement`) are manual.
- **Bugs slipped through.** This session's first-run setup shipped a view with no sections and a sheet that never closed, and only a manual headless run caught them.

## What this adds

- **A suite of operator journeys.** Real `zarg` runs on a pseudo-terminal in a brand-new project each time, and talks to the operator's real zarg-router with its real models:
  - the driver: `deepseek-v4.1-flash-exl3`;
  - the decision model: `jevk5`.
- **Two tiers:**
  - a fast tier, required before a push;
  - a full tier, run on demand.

## The harness (`packages/e2e`, `@zarg/e2e`, tests only)

- **`world()`: a fresh world per journey.**
  - **The project:** a temp dir with `git init` and one commit, and nothing else; a journey may seed files.
  - **The user dir:** a temp dir passed as `ZARG_USER_DIR`. The operator's `~/.config/zarg` is never read or written.
  - **A clean env:** `PATH`, `HOME` (a temp home), `TERM=xterm-256color`, and the zarg variables the journey sets. Nothing leaks in from the operator's shell.
  - **Cleanup:** the world is removed after a passing journey, and kept, with its path printed, after a failing one.
- **`zarg(world, args)`: the real CLI on a PTY.**
  - It runs `packages/cli/src/main.ts` with the repo's pinned bun, through Bun's built-in PTY (`Bun.spawn({ terminal })`), at 120×40.
  - Its output feeds `@xterm/headless` (a dev dependency), which keeps the screen.
  - The API:
    - `screen()`: the visible grid as text;
    - `waitFor(text | RegExp, timeoutMs)`;
    - `type(text)`;
    - `press(key)`: `enter`, `esc`, `tab`, `up`/`down`, `ctrl+k`, `alt+v`, `space`, and single letters;
    - `paste(text)`: bracketed paste;
    - `exit()`: Ctrl+D, then wait for the process to end.
- **`cli(world, args)`:** `zarg agenda`, `render`, `audit`, `tool call` and `core status` in the same world, answering their JSON, so a journey can assert the graph and state it leaves behind.
- **`login(t, world)`:** the shared first-run steps, used by every journey after `first-run`:
  1. In the Setup view, log in to zarg-router with `E2E_ZARG_ROUTER_URL` (default `http://localhost:11435/api/v1`).
  2. Pick `zarg-router:deepseek-v4.1-flash-exl3` as the default.
  3. Append `roles.decision = "zarg-router:jevk5"` to the world's user config. Setup only sets the default, and decisions would otherwise fall back to the driver's model.
- **The preflight**, run once before any journey:
  - `GET <router>/models` must list `deepseek-v4.1-flash-exl3` and `jevk5`. Otherwise the run stops with `zarg-router at <url> does not list <model>: start the router and load it`.
  - The suite never starts, restarts, warms or unloads anything on the router.
- **Plugins are built once per run** (`mise run build:plugins`).
- **Journeys run one at a time.** They share one GPU.

## Assertions on live models

- **Behaviour, never wording.** For example:
  - the driver asked a question with options;
  - after a yes, the graph has at least one scenario with a `by` persona;
  - the plan's `serves` names `O-0001`.
- **Model turns get long timeouts** (default 5 minutes per model step). Each journey records the time its model calls took.
- **One retry of the model step, never of the journey.**
  - A step that the model answered badly is tried once more: the operator's message sent again, or the agent woken again.
  - A step that fails twice is a failure, reported as `model step failed twice: <what was expected> / <what the screen showed>`.
  - A retried step that then passed is reported as `flaky:` in the summary, apart from real failures.

## The journeys

| Journey | Tier | What it proves |
|---|---|---|
| `first-run` | fast | Setup opens by itself (both providers `◇ not set up`). ⏎ on zarg-router, the URL typed and then pasted, `c` → `✓ reachable · N models`. The default is picked → the sheet closes, the conversation is ready. The user config holds the default. A second fresh project, with the same user dir, opens no setup. |
| `login-errors` | fast | A URL nothing listens on → `✗ is it running?`. No default is written, and the user config still loads (the next `zarg` starts). |
| `conversation` | fast | After `login`: the operator says what the product is for → the driver asks one question with options → the first option is picked → it proposes graph changes → yes. `zarg render` shows at least one scenario with a persona; `zarg agenda` answers. |
| `sessions` | fast | A second `zarg` in the same project is refused with the `--attach` hint. `zarg --attach` joins and shows the same conversation. Quitting the owner ends the core, and the attached client says the core went. A killed TUI's orphaned core is replaced by the next `zarg`. |
| `views` | fast | A journey added with `zarg tool call` is listed in the Journeys nav item. In the Intents view, `a` adds an outcome, `e` rewords it, ⏎ answers a question, `d` removes after Remove. Each change shows in `zarg render --focus I-0001`. |
| `intent-agent` | full | An intent with one outcome and a journey of built scenarios. Grant `intent` → a round runs on the live models → a plan whose `serves` names the outcome appears in the Backlog. Move it to Ready → the Planner applies it → `zarg audit` shows no `uncovered`. |
| `rehearse-to-backlog` | full | A journey of built scenarios (tagged code seeded in the world). `/rehearse` → testers file feedback → it shows in Feedback. Refine → a triage plan in the Backlog lane. |

## Running and gating

- **Tasks (root `mise.toml`):**
  - `mise run e2e`: build the plugins, run the preflight, then the fast tier.
  - `mise run e2e:full`: the fast tier, then the full tier.
  - `mise run e2e -- <journey>`: one journey.
- **The gate:**
  - `.githooks/pre-push` (committed) runs `mise run e2e`.
  - `mise run setup:hooks` sets `git config core.hooksPath .githooks`, and AGENTS.md's Setup lists it.
  - When the router is down, the hook fails with the preflight's message. `git push --no-verify` stays the operator's escape hatch.
- **On failure:**
  - `e2e-artifacts/<journey>/` (gitignored) holds:
    - the last screen as text;
    - the screens around each step;
    - the world's `.zarg/threads`;
    - the core's stderr;
    - the model-call timings.
  - The world is kept, and its path printed.
- **Never touched:** the operator's `~/.config/zarg`, their grants, the repo's own `.zarg`, and the router's state.

## Out of scope

- A deterministic tier with a fake provider. The operator chose the real router; stub mode stays for unit-level tests.
- Running journeys in parallel, while they share one GPU.
- OpenRouter, or any network outside localhost.
- Web clients.

## Tests of the harness itself

- `world()` makes a fresh repo and user dir, and cleans them up after a pass.
- `zarg()` on the PTY: `waitFor` finds text the TUI draws, `press` and `type` reach it, and `paste` arrives as one paste.
- The preflight fails with its message against a URL nothing listens on.
- Retry bookkeeping: a step that passes on its second try is reported `flaky:`, and one that fails twice is a failure.
