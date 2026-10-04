# Catalog for Any Project, and Its UX (evidence plan C of 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `zarg catalog` builds and serves the catalog in whatever project zarg runs in, and the site is redesigned for a human reader.
- **Home is the project's intent list:**
  - a verdict line;
  - the audit checks as a strip;
  - every intent, red first, with a filter;
  - uncovered work apart.
- **Journeys** are a timeline of scenario cards with thumbnails of their visual evidence.
- **Scenario pages** lead with the failure, then the evidence gallery.
- **Design:** the redesign goes through the `impeccable` skill and is recorded in `packages/catalog/DESIGN.md`.

**Architecture:**
- **No new packages.** `@zarg/catalog`'s model gains the project name, intent summaries, uncovered work and thumbnails. Its pages are rewritten to the new design, and its CSS stays built from `@zarg/tokens`.
- **The CLI's `catalog` command:**
  - builds into `.zarg/catalog/`, which holds its own `.gitignore`;
  - serves with the existing `serve`;
  - `catalog build` stays for CI.

**Tech Stack:** Bun 1.4, Effect 4, `@zarg/tokens`, `@zarg/highlight`, the `impeccable` skill (`~/.claude/skills/impeccable`), and headless Chromium (`/usr/bin/chromium`) for the browser check. The Claude-in-Chrome screenshots time out in this environment.

**Spec:** `docs/superpowers/specs/2026-10-04-evidence-plugins-design.md` ("A catalog for any project", "Pages", "Design").

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Plan 2's guarantees still hold, and keep their tests:**
  - deterministic bytes;
  - relative links (any sub-path);
  - opens from disk;
  - nothing from a CDN;
  - light and dark;
  - only committed media;
  - plugin HTML sanitized;
  - links percent-encoded.
- **Status words** stay the audit's (`proven`, `failing`, `stale`, `unproven`, `planned`), with the colours from `@zarg/tokens`. The redesign may add type, spacing and layout, never new status colours.
- **The project's own `.gitignore` is never edited.** `.zarg/catalog/` ignores itself with a `*` `.gitignore` inside, the way `.zarg/inbox/` does.
- The pages say "the operator", never "the developer".

## Review Focus

1. **A project with many intents (30+), long titles, and an intent with no journeys.** Expected: the home list stays scannable (one row each, titles wrapped, red first), the filter narrows it, and an intent with nothing gets "◇ no journey". Task 2 tests it.
2. **A project with no graph, no evidence and no git remote** (a brand-new repo). Expected: `zarg catalog build` succeeds with an empty-state home, named after the directory. Task 1 tests it.
3. **`--out` at the default, after an earlier build.** Expected: rebuilt from empty, and `.zarg/catalog/.gitignore` is still there. Task 1 tests it.
4. **A journey whose scenarios have no visual evidence.** Expected: cards without thumbnails and no broken images. A scenario whose first visual medium is not committed gets no thumbnail. Task 2 tests it.
5. **Phone width (400px).** Expected:
   - no page-wide horizontal scroll;
   - frames scale;
   - tables and Gherkin scroll inside their own boxes.

   Task 3 checks it in the browser.

---

### Task 1: `zarg catalog` in any project

**Files:**
- Modify: `packages/cli/src/commands.ts` (`catalogCmd`: default build+serve; `catalog build`), `packages/catalog/src/model.ts` (`project`), `packages/catalog/src/build.ts` (keeps `.gitignore`)
- Modify: root `mise.toml` (`catalog` task), `AGENTS.md`
- Test: `packages/cli/test/cli.test.ts`, `packages/catalog/test/build.test.ts`, `packages/catalog/test/model.test.ts`

**Interfaces:**
- **`catalogOf` input gains `project: string`, and `Catalog` gains `project: string`.**
- **`build`** writes `.gitignore` (`*\n`) in `out` when `out` is inside the project's `.zarg/`. The CLI passes `ignoreSelf: true` for the default output.
- **The CLI:**
  - `zarg catalog [--out .zarg/catalog] [--port 4173] [--open]` builds, prints the URL, and serves until stopped. `--open` opens the browser through `xdg-open`, `open` or `start`, whichever exists.
  - `zarg catalog build [--out .zarg/catalog]` builds only.
- **The project name** is `githubRepo(origin)`'s repo part (`zarg-v2`), else the remote's last path segment without `.git`, else `basename(root)`.

- [ ] **Step 1: Write the failing tests.**
  - **CLI**, in a fresh temp repo with one scenario and no remote: `zarg catalog build` exits 0, and
    - `.zarg/catalog/index.html` exists;
    - `.zarg/catalog/.gitignore` is `*\n`;
    - `index.html` contains the temp dir's basename;
    - building again keeps the `.gitignore`.
  - **CLI**, in a temp repo with no graph at all: `catalog build` exits 0 with an empty-state home ("No intents yet").
  - **model:** `catalogOf({ …, project: "demo" }).project === "demo"`.
  - **build:** `build({ …, ignoreSelf: true })` writes `.gitignore`; without it, no `.gitignore`.
  - **The serve path** is not unit-tested here; `serve.test.ts` already covers the server.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - The `catalog` command is `Command.make("catalog", { out, port, open }, handler).pipe(Command.withSubcommands([catalogBuild]))`.
  - Its handler builds with a shared `buildCatalogAt(out)`, then `serve(out, port)` and prints `the catalog: http://localhost:<port>`. It waits on `Effect.never`, so the server stops with the process (Ctrl+C).
  - The root `mise.toml` `catalog` task runs `mise x -- bun packages/cli/src/main.ts catalog`.
  - Remove `site/` from `.gitignore` only if nothing else writes there; `catalog build --out site` still works.
- [ ] **Step 4: Run them and watch them pass**, then commit `feat(catalog): zarg catalog builds and serves the catalog in any project (.zarg/catalog, ignored by itself)`.

---

### Task 2: The page data for the new home, journeys and failures

**Files:**
- Modify: `packages/catalog/src/model.ts`
- Test: `packages/catalog/test/model.test.ts` (new fixture graph helper `many(n)` for Review Focus 1)

**Interfaces:**
- **`IntentPage` gains:**
  - `counts: Counts`, over the scenarios in journeys serving any of its outcomes, each scenario once;
  - `journeys: ReadonlyArray<string>`, the journeys serving its outcomes, sorted.
- **`Overview` gains:**
  - `intents: ReadonlyArray<{ id; title; status; outcomes: number; journeys: number; counts: Counts }>`, sorted red first: by failing, then stale, then unproven, all descending, then by id;
  - `uncovered: { journeys: ReadonlyArray<{ id; name }>; scenarios: ReadonlyArray<{ id; title }> }`: journeys serving no outcome, and scenarios in no journey.
- **`ScenarioPage` gains `thumb?: string`,** the path of its first present medium of a visual kind. Visual kinds are `evidence-terminal/frame`, `evidence-screen/screenshot`, `evidence-screen/gif` and `evidence-screen/trace`, in the evidence's order, preferring "the screen after" when present.
- **`JourneyPage.steps` items** are unchanged. The journey page reads each scenario's `thumb` through the scenarios map.

- [ ] **Step 1: Write the failing tests.**
  - The fixture's intent counts: proven 1, planned 1. Its uncovered lists: none, and S-3.
  - With `many(35)` (35 intents, some with failing evidence, one with no journeys): `overview.intents` is ordered red first, and the no-journey intent has `journeys: 0`.
  - `thumb`: a scenario with a frame medium gets its path. One whose frame is not present gets none. One with only text media gets none.
- [ ] **Step 2: Run them and watch them fail.** Implement. Run them and watch them pass. Commit: `feat(catalog): intent summaries, uncovered work and thumbnails in the page data`.

---

### Task 3: The redesign, through `impeccable`

**Files:**
- Create: `packages/catalog/DESIGN.md`
- Modify: `packages/catalog/src/pages.ts` (layout, CSS and pages), `packages/catalog/test/pages.test.ts` (structure assertions updated, guarantees kept)

- [ ] **Step 1: Load the skill.** Run the `impeccable` skill: `node ~/.claude/skills/impeccable/scripts/context.mjs --target packages/catalog/src/pages.ts`, run with `mise x -- bun`, since this repo uses bun. Then read `reference/new-work.md`, and `reference/craft-floor.md` before editing.
  - **The brief:** a one-stop page for a human reader to know whether a product works, from intent to scenario, with replayable evidence.
  - **Audience:** the operator and their team, on desktop and phone.
  - **Incumbent visual truth:** `@zarg/tokens` (colours, the terminal look of zarg's TUI) and the evidence frames themselves.
  - **Constraints:** Global Constraints above.
- [ ] **Step 2: Write `DESIGN.md`:** the direction, type, spacing, layout per page, and status presentation, in the skill's format. Commit it on its own (`docs(catalog): DESIGN.md`).
- [ ] **Step 3: Rewrite the pages to the design.** Each page:
  - **Home:**
    - project name;
    - the verdict line (`12 of 66 scenarios proven · 0 failing · 3 stale`, red first);
    - the audit checks as a strip (problems red, warnings amber, zero quiet);
    - the intent list (one row per intent: title, status, outcomes and journeys count, proof bar, failing and stale counts; a filter box that narrows it as you type, client-side, and works from disk);
    - "Not yet tied to an outcome" (journeys) and "In no journey" (scenarios);
    - an empty state ("No intents yet: talk to zarg about what this project is for").
  - **Intent:**
    - the problem;
    - each outcome with its serving journeys as rows with proof bars, or "◇ no journey";
    - constraints with what they bound;
    - questions marked open or answered.
  - **Journey:**
    - the outcomes it serves;
    - a vertical timeline of scenario cards: persona, title, status, and the thumbnail (the medium's sanitized fragment scaled into a fixed box; an `<img>` for screenshots), plus the Gherkin folded under the card;
    - branches side by side, "↺ back to" as a link, the "not connected" ones apart.
  - **Scenario:**
    - on failure, first: expected beside what it saw, with the last frame or screenshot;
    - then the Gherkin;
    - then the evidence gallery: visual media large, text media folded;
    - then code links;
    - then proof metadata.
  - **Every page:** search in the header (the inline index, as now), and a theme toggle (stored per viewer, wrapped in try/catch).

  Keep `esc`, `encodePath`, `pages(c, rendered)` and the fragment rules. Update `pages.test.ts`'s structural assertions to the new markup. Every guarantee test stays: relative links, escaping, fallback cards, assets, search from disk, tokens light and dark.
- [ ] **Step 4: Check it in a browser.**
  1. Build this repo's catalog to the scratchpad and serve it.
  2. Screenshot `index.html`, `intents/I-0001.html`, `journeys/J-0002.html`, `scenarios/S-0067.html` and `scenarios/S-0001.html` with `chromium --headless=new --screenshot` at 1280×2400 and 400×2400, in light and dark (`--force-dark-mode`).
  3. Look at every one. Fix what the skill's craft floor or Review Focus 5 calls out.
  4. Record what you saw in the ledger.
- [ ] **Step 5: Run the tests** (catalog and CLI), then commit `feat(catalog): the catalog redesigned: intent-list home, journey timelines with thumbnails, failure-first scenarios`.

---

### Task 4: Docs and the order

**Files:**
- Modify: `AGENTS.md` (the `packages/catalog` line: `zarg catalog` in any project, `.zarg/catalog/`, the pages, `DESIGN.md`), `docs/superpowers/specs/2026-10-04-e2e-suite-design.md` (the catalog section points at the evidence-plugins spec for pages and serving)

- [ ] **Step 1: Edit the docs.** Run `mise run verify`, then commit `docs: the catalog in any project`.

---

## Self-Review

- **Spec coverage, plan C:**
  - `zarg catalog` in any project, `.zarg/catalog/` ignoring itself, the project name: Task 1;
  - the intent-list home, the uncovered sections, intent pages, journey timelines with thumbnails, failure-first scenario pages, search in the header: Tasks 2 and 3;
  - `impeccable` with `DESIGN.md`, checked in a browser at desktop and phone widths: Task 3.
- **Out of scope:** GitHub Pages publishing (deferred, as in the e2e spec).
- **Placeholders:** Task 3's exact markup is the skill's to decide. The plan fixes what each page holds, the guarantees, and how the result is checked.
- **Types:** `Counts`, `Catalog`, `ScenarioPage` and `MediaView` are from plan 2 and plan A. The new fields are `project`, `IntentPage.counts` and `.journeys`, `Overview.intents` and `.uncovered`, and `ScenarioPage.thumb`.
