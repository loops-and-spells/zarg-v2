# End-to-end proof: the graph's journeys walked on a new project, on the real models

Date: 2026-10-04 · Status: approved design (the operator), pending spec review. Terms: `docs/taxonomy.md`

## Problem

- **Nothing tests zarg the way the operator meets it.**
  - The one TUI test renders in-process.
  - The core's stub mode bypasses providers, setup and the router.
  - The smoke scripts are manual.
  - This session's first-run setup shipped a view with no sections and a sheet that never closed, and only a manual run caught them.
- **The graph says what zarg should do, but nothing shows that it does.**
  - The audit knows whether a scenario is *built* (its code is tagged) or *planned*.
  - Nothing records that a scenario *works* end to end, at the version the graph holds now.

## What this adds

- **zarg dogfoods its graph.** The e2e suite walks the graph's own journeys, one step per scenario, as the operator would. It runs real `zarg` on a pseudo-terminal, in a brand-new project each time, against the operator's real zarg-router:
  - the driver: `deepseek-v4.1-flash-exl3`;
  - the decision model: `jevk5`.
- **Evidence:** every step that passes writes evidence for its scenario at that scenario's content version, with links to media captures.
- **The chain:** intent → outcome → journey → scenario → code (`@scenario` tag) + **proof** (evidence).
- **Every journey is held to green.** A scenario that is `failing` or `unproven` is an audit problem, and red becomes work: a fix plan for reconcile, or a question for the operator in the inbox.

## The harness (`packages/e2e`, `@zarg/e2e`, tests only)

- **`world()`: a fresh world per journey.**
  - **The project:** a temp git repo with one commit; a journey may seed files, such as tagged code for built scenarios.
  - **The user dir:** a temp dir passed as `ZARG_USER_DIR`.
  - **The home:** a temp `HOME`.
  - **A clean env:** `PATH`, `HOME`, `TERM=xterm-256color`, plus the zarg variables the journey sets.
  - **Cleanup:** the world is removed after a pass, and kept, with its path printed, after a failure.
  - **Never touched:** the operator's `~/.config/zarg`, their grants, the repo's own `.zarg`, and the router's state.
- **`zarg(world, args)`: the real CLI on Bun's built-in PTY** (`Bun.spawn({ terminal })`, 120×40).
  - Its output feeds `@xterm/headless`, a dev dependency.
  - The API: `screen()`, `waitFor(text | RegExp, timeoutMs)`, `type(text)`, `press(key)`, `paste(text)` (bracketed paste), `exit()`.
- **`cli(world, args)`:** `zarg agenda`, `render`, `audit`, `tool call` and `core status`, answering JSON.
- **`login(t, world)`:** the first-run steps shared by every journey after Set up:
  1. In the Setup view, log in to zarg-router with `E2E_ZARG_ROUTER_URL` (default `http://localhost:11435/api/v1`).
  2. Pick `zarg-router:deepseek-v4.1-flash-exl3` as the default.
  3. Write `roles.decision = "zarg-router:jevk5"` into the world's user config.
- **The preflight**, once per run: the router's `GET /models` must list both models. Otherwise the run stops with `zarg-router at <url> does not list <model>: start the router and load it`. The suite never starts, restarts, warms or unloads anything on the router.
- **Plugins are built once per run.** Journeys run one at a time, since they share one GPU.

## The graph decides what is walked

- **One file per graph journey:** `packages/e2e/journeys/J-0002.test.ts` declares `journey("J-0002", …)`.
- **One step per scenario:** `proves("S-0026", async (t) => …)`, walked in the journey's flow order (the graph's arrivals and Thens).
- **Agent-internal scenarios** (the Planner, Implementer or Plugin Agent) are proven through what they leave behind: a plan file, a landed commit, a status line, a view's row.
- **A scenario in several journeys** is proven once, by any of them.
- **A step may only `proves` a scenario of its own journey,** and the harness checks the graph to enforce it.
- **Model turns:**
  - Assertions are on behaviour, never on a model's wording.
  - Model steps get long timeouts (5 minutes by default), and their call times are recorded.
  - A model step gets one retry, never the whole journey. A step that passes on retry is marked `flaky`; one that fails twice fails.

## Evidence (committed: `.zarg/evidence/<S-id>.json`, one file per scenario)

```json
{
  "scenario": "S-0026",
  "version": "3f9a1c20b7e4",
  "commit": "1e92d6e",
  "run": "e2e-2026-10-04T10-12-33",
  "journey": "J-0002",
  "passed": true,
  "flaky": false,
  "at": "2026-10-04T10:13:02Z",
  "ms": 4180,
  "media": [
    { "kind": "buffer", "path": "media/S-0026/after.txt", "caption": "the Setup sheet, both providers not set up" },
    { "kind": "cast", "path": "media/S-0026/step.cast", "caption": "the step, replayable (asciinema)" }
  ],
  "failure": null
}
```

- **`version`:** the scenario's content version, the same one feedback pins. A reworded scenario is `unproven` until a run walks it.
- **Writes:** a run writes the file of every scenario it walked. A failed step writes `passed: false` with `failure`: what was expected, and the media of the moment it failed.
- **Media kinds** are framework-neutral and declared by the harness that captures them:

  | Kind | What | Captured by |
  |---|---|---|
  | `buffer` | the terminal's visible grid as text, at a moment | the TUI harness (`screen()`), before and after each step |
  | `cast` | the step's terminal session, replayable (asciicast v2) | the TUI harness (the PTY stream, with timings) |
  | `image` | a still (PNG) | a future web or native harness; a rendered terminal frame |
  | `gif` / `video` | an animation or recording | a future web harness (Playwright video), or a cast rendered to GIF |
  | `log` | excerpts from logs the step produced (core stderr, thread events) | any harness |

  The contract is the same whatever the harness: `{ kind, path, caption, mime? }`. Today's TUI harness captures `buffer`, `cast` and `log`; others plug in their own.
- **Where media lives:** `.zarg/evidence/media/<S-id>/`.
  - Text media (`buffer`, `cast`, `log`) is committed with its evidence. It is small and diffable, and it is the proof a reviewer reads.
  - Binary media (`image`, `gif`, `video`) is written beside it, but gitignored by default, with its path still recorded. `[e2e] media = "commit"` in `.zarg/config.toml` commits it too, for repos that want it, with LFS or not as the repo decides.
- **Evidence is replaced, not appended.** Only the latest run per scenario is kept; history is git's.
- **Where it shows:**
  - `zarg audit --scenario S-0026` prints the proof status and media paths.
  - Fix plans and inbox topics carry the failing step's media as evidence.
  - The Journeys view's scenario detail shows `✓ proven <run>` or `✗ failing` with the last `buffer` inline.

## Audit: always enforced

- Every built scenario has a proof status:
  - `proven`: it passed at its current version;
  - `failing`: the last run at its current version failed;
  - `unproven`: no evidence at its current version.
- `failing` and `unproven` are **problems**, so `verify` fails.
- Planned scenarios are exempt until built, as today.

## Red becomes work

The core watches `.zarg/evidence` (as it watches the graph) and turns each red scenario into work.

| Red | Becomes |
|---|---|
| `failing` | A backlog **fix plan** (`kind: "code"`): "S-0026 fails end to end", with the failure and its media. Reconcile's implement phase takes it like a scenario change: fix the code, re-run that journey's e2e, land once it passes. If the fixer judges the scenario wrong rather than the code, it raises an inbox question (reword the scenario, or change the code), as drift does today. |
| `unproven`, reworded | Nothing is asked: the journey's next run walks it. If that run fails, it becomes `failing`. |
| `unproven`, no step | A backlog plan "prove S-0091 end to end": write its step in its journey's file. Reconcile's implement phase treats proof as part of building a scenario, so code and proof land together. |
| A step failing twice on a model answer, that the fixer cannot attribute to code or scenario | One inbox topic per journey (never per step), with the media. |

## Running

- **Tasks (root `mise.toml`):**
  - `mise run e2e`: build the plugins, run the preflight, then the **fast tier**: journeys that need no model turns. Today that is J-0002 Set up, J-0003 Watch agents and J-0005 CLI actor.
  - `mise run e2e:full`: adds the **full tier**: journeys with model turns, today J-0001 Talk with zarg and J-0004 Reconcile.
  - `mise run e2e -- J-0002`: one journey.
- **The gate:**
  - `.githooks/pre-push` runs `mise run e2e`, and `mise run setup:hooks` sets `core.hooksPath`.
  - When the router is down, the preflight message says why. `--no-verify` remains git's escape hatch.
- **After a run:**
  - The evidence files changed by the run are left for the operator to commit with their work. The run never commits by itself.
  - A failing journey also leaves `e2e-artifacts/<journey>/` (gitignored): the world's logs, and the kept world's path.

## Getting there (the order)

1. **The harness**, with its own tests: world, PTY + xterm, the preflight, retry bookkeeping, the evidence and media writers.
2. **The graph catches up:**
   - drive the scenarios of this session's features into the graph (zarg-drive, with the operator): first-run setup, `/login` and `/models`, the Intents view, the intent agent, one core per session;
   - tag their code.
3. **Coverage, journey by journey:** write each journey's steps until a full run is green for all built scenarios.
4. **Red becomes work:** the core's evidence watcher, fix plans, prove plans and inbox topics.
5. **Strict:** audit's proof statuses become problems, once a full run is green.

## Out of scope

- A deterministic tier with a fake provider (stub mode stays for unit tests).
- Running journeys in parallel.
- Networks outside localhost.
- Web and native harnesses. The media contract is ready for them.
- Rendering casts to GIF. The `gif` kind is in the contract, but nothing renders one yet.

## Tests of the harness itself

- `world()` makes a fresh repo, user dir and home, and cleans them up after a pass.
- On the PTY: `waitFor` finds drawn text, `press` and `type` reach the TUI, and `paste` arrives as one paste.
- The preflight fails with its message against a URL nothing listens on.
- Retry bookkeeping: a step that passes on its second try is recorded `flaky: true`, and one that fails twice fails.
- Evidence: a passing step writes its file at the scenario's current version with `buffer` and `cast` media. A failing one writes `passed: false`, its failure and media. A `proves` naming another journey's scenario is refused.
- The core's evidence watcher: a `failing` file produces one fix plan, and a `flaky` journey failure produces one inbox topic, not one per step.
