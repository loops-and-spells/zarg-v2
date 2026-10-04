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

## One command for CI: `zarg audit`

`zarg audit` is the single check CI runs (and `verify` with it). It says whether the graph is complete and proven, and it exits 1 on any problem.

| Check | Problem when | Source today |
|---|---|---|
| **Graph structure** | a dangling edge; a node whose file does not parse; edge limits broken; an unknown node type | the host's structural check and `invalid-file` agenda items |
| **Graph lints** | any error-level lint over the whole graph: atomic clauses (length, no "if"), duplicate states, persona and journey shape, intent titles, a statement in no intent or in two | the plugins' `lint`, which `zarg lint` runs today, run over every node, not only the changed ones |
| **Completeness** | a scenario in no journey; a scenario with no `by` persona; a dead end (a state no scenario continues from, not `terminal`); an unreached state (not `entry`); an open intent question; an intent with no outcome | gherkin's agenda items, the ones that mean "incomplete", as problems |
| **Intent coverage** | `uncovered` (an outcome no journey serves); `unserving` (a journey serving no outcome) | today's audit warnings, as problems |
| **Code** | `untagged`, `planned-but-tagged`, `orphan` | today's audit |
| **Proof** | `unproven`, `failing`, and **`stale`**: the scenario's tagged code changed after its evidence commit (`git log` on the tagged files is newer than `evidence.commit`) | the evidence files |
| **Evidence integrity** | an evidence file for no scenario; one whose `version` is malformed; a media path that does not exist; a `commit` the repo does not have | the evidence files |

- **Output:**
  - the default is the summary: one line per problem, grouped by check, then a count line per check;
  - `--json`: every check with its items, for tools;
  - `--junit <file>`: one test case per scenario (proven passes; unproven, failing and stale fail, with the media paths in the message), so CI shows proof like test results.
- **Exit codes:** `0` when complete and proven; `1` on any problem; `2` when the audit itself could not run (an unreadable graph, git missing).
- **`zarg lint`** stays, as the lints alone; `zarg audit` includes them.
- **Planned scenarios** are exempt from Code and Proof, as today; they still count in Structure, Lints and Completeness.
- **The gate:** `mise run verify` runs `zarg audit`, so the strict switch in "Getting there" (step 5) is when Completeness, Intent coverage and Proof stop being reported as warnings. A CI job needs only `mise run audit` (no models, no router): it checks the committed graph and evidence. Running the e2e suite to refresh the evidence is a separate job on a machine with the router.

## The catalog: a static site of the intent, the journeys, the scenarios and their proof

> Superseded in part by `docs/superpowers/specs/2026-10-04-evidence-plugins-design.md`: evidence renders through evidence plugins, the catalog builds and serves in any project (`zarg catalog`, `.zarg/catalog/`), and its pages follow `packages/catalog/DESIGN.md`.

A human reader's one stop to know whether everything works: the graph from intent to scenario, each scenario's proof, and the captured evidence, replayable.

- **Built by** `zarg catalog build [--out site]` (package `packages/catalog`, `@zarg/catalog`). It is a plain static site: HTML, CSS and a little JS, with no server needed. It reads the committed graph, `.zarg/evidence` and its media, and the audit.
- **Served locally** by `mise run catalog`: build, then serve `site/` with Bun on `http://localhost:4173`. The same output is what a GitHub Pages workflow publishes later (out of scope for now; the site works from any static host and under a sub-path).
- **Pages:**

  | Page | Shows |
  |---|---|
  | **Overview** | the audit at a glance: every check's count, red first; proven / failing / stale / unproven / planned per journey as bars; the run and commit the evidence comes from |
  | **Intent** (per intent) | its problem; each outcome with the journeys serving it (or "◇ no journey"); constraints and what they bound; open questions |
  | **Journey** (per journey) | the outcomes it serves; its scenarios in flow order (the graph's own arrivals and Thens), each as Gherkin with its status badge |
  | **Scenario** (per scenario) | its Given / When / Then with persona; its version; its code (each `@scenario` tag as `file:line`, linked to the repo when the git remote is GitHub); its proof (run, commit, time, flaky or not); its **evidence**: buffer snapshots before and after as terminal frames, the step's cast **replayable** (play, pause, scrub), images and gifs inline, videos with a player, logs folded; on failure, what was expected and the frame it failed on |
  | **Search** | every intent, outcome, journey and scenario by text and id, client-side |

- **Players:**
  - **Casts:** the asciinema player (`asciinema-player`, an npm dependency, copied into the site, so nothing comes from a CDN).
  - **Buffers:** shown as monospace frames.
  - **Images and gifs:** `<img>`.
  - **Videos:** `<video>`.
  - **Binary media that is not committed:** shown as "captured on the run's machine, not committed" instead of a broken link.
- **Status words** are the audit's own (`proven`, `failing`, `stale`, `unproven`, `planned`), with the same colours everywhere.
- **No secrets:** the site holds only what is committed (the graph, the evidence and its text media), and a build refuses to copy a media file that is not under `.zarg/evidence/media`.
- **Deterministic:** the same graph and evidence build the same site byte for byte, sorted throughout, with no build timestamp in pages. A catalog diff shows what changed.

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
5. **The catalog**: `zarg catalog build` and `mise run catalog`.
6. **Strict:** `zarg audit` reports Completeness, Intent coverage and Proof as problems (they are warnings until then), once a full run is green; CI runs `mise run audit`.

## Out of scope

- A deterministic tier with a fake provider (stub mode stays for unit tests).
- Running journeys in parallel.
- Networks outside localhost.
- Web and native harnesses. The media contract is ready for them.
- Rendering casts to GIF. The `gif` kind is in the contract, but nothing renders one yet.
- The GitHub Pages workflow. The catalog is built to be published from any static host; the workflow comes after it is in use locally.

## Tests of the harness itself

- `world()` makes a fresh repo, user dir and home, and cleans them up after a pass.
- On the PTY: `waitFor` finds drawn text, `press` and `type` reach the TUI, and `paste` arrives as one paste.
- The preflight fails with its message against a URL nothing listens on.
- Retry bookkeeping: a step that passes on its second try is recorded `flaky: true`, and one that fails twice fails.
- Evidence: a passing step writes its file at the scenario's current version with `buffer` and `cast` media. A failing one writes `passed: false`, its failure and media. A `proves` naming another journey's scenario is refused.
- The core's evidence watcher: a `failing` file produces one fix plan, and a `flaky` journey failure produces one inbox topic, not one per step.
- The catalog: a fixture graph and evidence build the expected pages (an intent, a journey in flow order, a scenario with buffer, cast and image evidence, a failing one with its frame); two builds are identical; a media path outside `.zarg/evidence/media` is refused; links work under a sub-path.
- `zarg audit`: each check's problem on a fixture graph and evidence set (a dangling edge, an "if" clause, a dead end, an uncovered outcome, an untagged scenario, a stale proof, a missing media file); `--json` and `--junit` shapes; exit codes 0, 1 and 2.
