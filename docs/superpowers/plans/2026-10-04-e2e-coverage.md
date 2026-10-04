# E2E Coverage and Strict (e2e plan 4 of 4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every built scenario in the graph is proven by an e2e step, and then `zarg audit --strict` fails CI on anything unproven, failing or stale.
- The graph has 110 built scenarios over 9 journeys; 5 are proven and 9 stale today.
- The **fast tier** runs with no models: it covers everything a step can drive with zarg's own UI, the CLI, seeded project files and a fake provider.
- The **full tier** runs on the live zarg-router. It covers what only a model does: the Driver Agent's conversation, the agents' work, reconcile, rehearse, triage and intent drafting.

**Architecture:**
- **Harness, gaps closed:**
  - steps can be marked `model: true`, and the fast tier skips them (a journey mixes both kinds);
  - a fake provider (an OpenAI-wire `/models` endpoint behind a key, served by the step);
  - seeds for backlog, feedback and evidence files;
  - TUI helpers that pick by label (`t.choose("Not now")`).
- **Journeys:** one file per journey (`packages/e2e/journeys/J-xxxx.test.ts`), with steps in flow order and a shared world.
- **Probe first.** Before writing a TUI step, find the real screen by running the TUI in a world and reading `t.screen()` (as J-0002 did). A product bug found this way is fixed in its own package with its own test (as with the `/` burst and pipe truncation fixes).
- **Strict:** `zarg audit --strict` makes completeness, coverage and proof problems. CI and `mise run verify` switch to strict once the full tier has proven every built scenario.

**Tech Stack:** `@zarg/e2e` (Bun PTY with headless xterm), `@zarg/evidence-capture(-xterm)`, `Bun.serve` (the fake provider), the live zarg-router at `E2E_ZARG_ROUTER_URL` (full tier only: deepseek-v4.1-flash-exl3 and jevk5, never started, loaded or warmed by the suite).

**Spec:** `docs/superpowers/specs/2026-10-04-e2e-suite-design.md` ("Tiers", "Audit: always enforced", "Getting there"), and `docs/superpowers/specs/2026-10-04-evidence-plugins-design.md`.

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Worlds only.** A step never runs zarg, a core or the TUI in the repo root, never writes `~/.config/zarg`, and never touches the router's state.
- **Ask before any full-tier run** (it uses the live models). The fast tier needs no router and runs in the pre-push hook.
- **A step proves only its own journey's scenarios**, and only through what a user or a CLI actor sees: screens, CLI output, files the product leaves. It never reads internals.
- **Evidence:** each committed medium is text (frames, casts, transcripts). Steps that use the fake provider never commit its key; keys are made up per world.
- **Flaky model steps** retry once, then are recorded `flaky`. A failing step is a finding to fix, never a step to loosen.

## Review Focus

1. **A fast-tier run on a machine with no router.** Expected: every `model: true` step is skipped with no evidence written (its scenario stays unproven, never failing), and the run passes. Task 1 tests it.
2. **The fake provider refusing a key, then accepting another.** Expected: Setup shows the refusal, then "reachable". The same world serves both steps. Task 2 tests it.
3. **Seeded backlog or feedback files with a stale scenario version.** Expected: the product's own staleness rules apply (⚠ changed), and the step asserts what the operator sees. Task 5 covers it.
4. **A full-tier step whose model answers differently each run.** Expected: assertions on the outcome the scenario promises (a question with options exists, a plan landed), never on the model's wording. Tasks 7 to 9.
5. **`--strict` on a repo with planned scenarios.** Expected: planned scenarios are skipped, not unproven; strict fails only on built ones. Task 10 tests it.

---

## Coverage map

| Journey | Fast tier | Full tier (model) |
|---|---|---|
| J-0002 Set up | S-0026–28, 30, 34, 35, 84–91 (fake provider), S-0060–66, 68, 70 (plugins and grants) | — |
| J-0005 CLI actor | all 12 (refresh) | — |
| J-0006 Inbox | S-0092–97 (grant and report topics) | S-0098 (zarg's question survives a restart) |
| J-0007 Intents | S-0099–101 (Intents view) | S-0102 (Driver keeps an intent), S-0103–104 (Intent Agent) |
| J-0008 Rehearse and refine | S-0121, 108, 109, 111, 112 (seeded feedback and plans) | S-0105–107 (testers), S-0110 (triage drafts) |
| J-0009 Prove | all 8 (audit, evidence and catalog in a world) | — |
| J-0001 Talk with zarg | — | all 15 |
| J-0003 Watch agents | — | all 11 |
| J-0004 Reconcile | — | all 17 |

---

### Task 1: The harness: model steps, a fake provider, seeds, choosing by label

**Files:**
- Modify: `packages/e2e/src/proof.ts` (a step with `model: true` is skipped in the fast tier), `packages/e2e/src/term.ts` (`choose(label)`, `waitGone(text)`)
- Create: `packages/e2e/src/fake-provider.ts`, `packages/e2e/src/seed.ts`
- Test: `packages/e2e/test/{proof,harness,fake-provider,seed}.test.ts`

**Interfaces:**
```ts
// proof.ts: a step that needs the router
proves("S-0098", step, { model: true })   // skipped when E2E_TIER=fast: no evidence written, its scenario stays as it was
// term.ts
readonly choose: (label: string) => Promise<void>       // moves the selection to the option labelled `label`, then Enter
readonly waitGone: (what: string | RegExp, timeoutMs?: number) => Promise<string>
// fake-provider.ts: an OpenAI-wire provider for setup steps
export const fakeProvider: (opts: { key: string; models: ReadonlyArray<string> }) => { readonly url: string; readonly stop: () => void }
// GET {url}/models with `Authorization: Bearer <key>` → { data: [{ id, context_length }] }; any other key → 401
// seed.ts: product files a step starts from, as the product writes them
export const seed: { feedback(w: World, entries: ReadonlyArray<FeedbackSeed>): void; plan(w: World, plan: PlanSeed): void; evidence(w: World, e: Evidence, media?: Record<string, string>): void }
```
- `FeedbackSeed` and `PlanSeed` are built through the backlog's own contract types (`@zarg/plugin-backlog/contract`), so the seeds stay what the product reads.

- [ ] **Step 1: Write the failing tests:**
  - with `E2E_TIER=fast`, a `model: true` step writes no evidence while the fast step beside it does;
  - `fakeProvider`: the right key lists the models, a wrong key gets a 401, and `stop` frees the port;
  - `choose` picks "Not now" in a two-option popover drawn by a fixture;
  - the seeds write files that `zarg` reads back (`zarg agenda` in the world lists the seeded feedback's journey).
- [ ] **Step 2: Run them and watch them fail. Implement. Run them and watch them pass.** Commit: `feat(e2e): model steps, a fake provider, seeds, choosing by label`.

---

### Task 2: J-0002 Set up, the rest (fast)

**Files:** `packages/e2e/journeys/J-0002.test.ts` (extend; S-0069 and S-0067 stay first)

- **Steps in flow order** (each probed first):
  1. **S-0084:** start zarg (no default model). The Setup sheet lists the providers, each "◇ not set up".
  2. **S-0026:** log in to `zarg-router`. Its settings are listed, and the key field is masked (the frame shows dots).
  3. **S-0028:** set its URL to the fake provider's and a wrong key, then check and save. The sheet shows "the key was refused".
  4. **S-0027:** set the right key, then check and save. The sheet shows "✓ reachable · N models". The key is not readable in `.env.local` (varlock-encrypted).
  5. **S-0034:** the models table lists the fake provider's models.
  6. **S-0035:** pick one as the default. `config.toml` in the world's user dir has `default = "zarg-router:<model>"`.
  7. **S-0085:** the sheet closes on its own.
  8. **S-0086 and S-0087:** `/login`, then `/models`. The sheet reopens.
  9. **S-0030:** stop the fake provider and restart zarg. The sheet opens again, the provider no longer answering.
  10. **S-0088 to S-0091**, sessions, using a second `zarg` in the same world:
      - start a session: `core status` shows it;
      - kill the first session's process and start again: the gone session's core is replaced;
      - run a second TUI while the first lives: refused, naming `--attach`;
      - `zarg --attach`: joins.
  11. **S-0060 to S-0066, S-0068, S-0070,** plugins and grants:
      - `zarg plugin add` with a fixture plugin built into the world: installed, and waiting for approval;
      - approve;
      - optional scope: allow once, always allow, deny;
      - an undeclared scope refused;
      - a failing plugin disabled;
      - `/yolo off`.

      The fixture plugins come from `packages/plugin/test/fixtures` sources, built into the world with `zarg plugin build`.
- [ ] Write the steps, run `mise run e2e -- J-0002`, and fix any product bug found (own test, own commit). Commit the journey and its evidence: `test(e2e): J-0002 Set up proven end to end`.

---

### Task 3: J-0006 Inbox (fast; S-0098 full)

- **Topics to work on** come from real sources in a world:
  - grant questions (blocking): seed a non-first-party plugin, or use first-party backlog's own grant;
  - reports (non-blocking): seed a finished rehearse run's report through the backlog seed, or a round's plans report.

  Probe which reports a seeded world raises.
- **Steps:**
  - **S-0092:** the inbox lists open topics, blocking first.
  - **S-0093:** answer a topic by its number. It leaves the open list, and its asker acts (the plugin loads after a grant).
  - **S-0094:** answer with a reason (`t`). The reason shows in the answered topic (`a`).
  - **S-0095:** mark two topics of one kind (space), then answer once. Both are answered.
  - **S-0096:** snooze a report (`z`). It moves to the end.
  - **S-0097:** snooze a blocking grant. Refused, and it stays first.
  - **S-0098** (`model: true`): ask the driver something that makes it ask the operator a question, then restart the core (quit and `zarg` again). The question is still open.
- [ ] Write, run, fix, commit: `test(e2e): J-0006 Inbox proven`.

---

### Task 4: J-0007 Intents (fast; S-0102–104 full)

- **Steps:**
  - **S-0099:** open the Intents view (nav). It lists the seeded intent's statements. Seed the intent through `zarg tool call gherkin/add-intent …`.
  - **S-0100:** `a` adds an outcome. The view lists it, and `zarg render --focus I-…` shows it.
  - **S-0101:** answer an open question (⏎). The answer shows.
  - **S-0102** (`model: true`): tell zarg what the product is for. A new outcome appears in the graph.
  - **S-0103** (`model: true`): with the intent agent granted, a new outcome without requirements gets a plan in the Backlog.
  - **S-0104** (`model: true`): an outcome the model cannot draft (seed one that conflicts with an existing constraint) raises an inbox topic.
- [ ] Write, run, fix, commit: `test(e2e): J-0007 Intents proven`.

---

### Task 5: J-0008 Rehearse and refine (fast part)

- **Seeds:**
  - a small graph with a journey and two built scenarios (code tagged in the world);
  - open feedback on them (`seed.feedback`);
  - one plan in Backlog (`seed.plan`).
- **Steps:**
  - **S-0121:** open the Feedback view (nav). It lists the journey's open feedback.
  - **S-0108:** turn a finding off (space). It shows off, and stays out of the next round.
  - **S-0109:** Refine (`r`). The journey shows queued for triage.
  - **S-0111:** move the seeded plan to Ready (⇧→). The Planner applies its scenario changes: `zarg render` shows them, and a commit names them.
  - **S-0112:** drop a plan. Its journey goes back to unplanned.
- [ ] Write, run, fix, commit: `test(e2e): J-0008 Rehearse and refine, the operator's part, proven`.

---

### Task 6: J-0009 Prove (fast)

In a world with a small graph, tagged code and seeded evidence:
- **S-0113:** `zarg audit --summary` lists each check, and exits 1 on a problem (an untagged built scenario) and 0 once it is fixed.
- **S-0114 and S-0115:**
  - run `zarg`'s own harness against the world's project through a tiny journey file in the world (a `journey()` over its graph, with `E2E_EVIDENCE_ROOT` set to the world);
  - its evidence file appears with a frame and a cast.
- **S-0116:** the world's journey has a step that fails. The evidence records expected and saw, and the audit lists it failing.
- **S-0117:** change the tagged code, and the audit lists the scenario stale.
- **S-0118:** `zarg catalog` serves the world's catalog. Fetch `/`: the verdict line, failing first.
- **S-0119:** the scenario's page holds its frame (SVG) and the cast player.
- **S-0120:** evidence of an unknown kind (`seed.evidence` with `evidence-x/y`) shows the fallback card naming `evidence-x`.

Commit: `test(e2e): J-0009 Prove proven`.

---

### Task 7: J-0001 Talk with zarg (full)

- **Every step is `model: true`,** with assertions on outcomes and never on wording:
  - **S-0008:** a question with 2–4 options, one recommended;
  - **S-0009:** picking an option changes the graph;
  - **S-0010:** a next question follows;
  - **S-0011:** typing their own answer;
  - **S-0012 and S-0013:** chatting about the question gets a reply without losing the question;
  - **S-0014 and S-0015:** what next lists topics, and picking one;
  - **S-0016:** an answer meets a newer edit, made by `zarg tool call` meanwhile;
  - **S-0071:** "you choose" makes the driver decide and say so;
  - **S-0072:** zarg's working indicator;
  - **S-0075 to S-0078:** formatted replies, reports, diagrams and their source.
- **Seed:** a world with a small graph and one intent, and `[roles] default` pointing at the live router.
- **Before writing it:** probe on the live router (ask first), recording what each screen shows.
- [ ] Commit after the user approves the run: `test(e2e): J-0001 Talk with zarg proven on the live models`.

---

### Task 8: J-0003 Watch agents (full)

- **S-0040 to S-0044, S-0073, S-0074:** start work that spawns agents (a `/rehearse` on a tiny journey):
  - the agents rail shows them, a child appears, and a decision shows;
  - a seeded tiny budget runs out;
  - stopping an agent;
  - inspecting it (⏎), folding its children.
- **S-0045 to S-0048**, secrets:
  - a seeded secret in the world's `.env.local` never shows in an agent's view or log (the frame and log media are grepped for its value: they must not contain it);
  - an agent cannot read `.env*`;
  - commands run without the secret in env;
  - a service outside the preset is refused.
- [ ] Commit: `test(e2e): J-0003 Watch agents proven`.

---

### Task 9: J-0004 Reconcile (full) and the rest of the full tier

- **J-0004** (all 17): a world repo with a tiny project (one module, its test, `verify` as `bun test`), with reconcile turned on (`S-0058`).
  - **Happy path:** a scenario changed through `tool call`; reconcile picks it up; plans are written; the Implementer updates code; verify passes; the commit lands.
  - **Each failure branch** is set up by its seed: a verify that cannot pass, a moved branch (a commit made during the pass), obvious and major conflicts (edits to the same lines), a scenario that cannot be planned (a contradiction).
  - **Each Then** is checked through git and the inbox.
- **The model steps of J-0006, J-0007 and J-0008:** S-0098, S-0102 to S-0104, S-0105 to S-0107, S-0110.
- [ ] Commit per journey after the user approves each run.

---

### Task 10: Strict

**Files:** `packages/audit/src/index.ts` (it already takes `strict`), `packages/cli/src/commands.ts` (`--strict`), root `mise.toml` (`audit` task), `AGENTS.md`

- **The flag:** `zarg audit --strict` passes `strict: true`. Completeness, coverage and proof become problems; planned scenarios are never counted.
- **Test:** in a temp repo, a built unproven scenario passes plain `audit` but fails `--strict`, and a planned one passes both.
- **The switch:** once `zarg audit --strict` passes in this repo (every built scenario proven after the full tier), the `audit` task runs `--strict`, so `verify` and CI fail on anything red. Until then the task stays as it is, and the plan's ledger records the remaining unproven list.
- [ ] Commit: `feat(audit): --strict; verify is strict once every built scenario is proven`.

---

## Self-Review

- **Spec coverage:**
  - "coverage, journey by journey": Tasks 2–9;
  - "the strict switch": Task 10;
  - "red becomes work" is e2e plan 3 and is separate.
- **Placeholders:** the TUI keys and screen texts are found by probing, by design. Each step names what it must assert, and the plan says how to find the exact text.
- **Order:**
  - the fast tier first (Tasks 1–6), committed and pushed with the pre-push hook;
  - the full tier (Tasks 7–9) only with the user's go-ahead per run;
  - strict last.
