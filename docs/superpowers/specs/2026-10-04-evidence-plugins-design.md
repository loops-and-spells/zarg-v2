# Evidence plugins: capture in any runner, render in any catalog

## Problem

Plans 1 and 2 of the e2e suite made evidence and a catalog, but evidence is closed:
- **Fixed media kinds.** There are six (`buffer`, `cast`, `log`, `image`, `gif`, `video`), captured only by zarg's own PTY harness and rendered by code baked into `@zarg/catalog`.
- **Many frameworks.** Projects zarg works on use many e2e frameworks across many platforms (Playwright, Cypress, Detox, Appium, XCUITest, terminals), and each captures differently.
- **No visuals.** The evidence holds no visual frames: J-0005's proof is CLI transcripts. Today's terminal buffers drop colour and layout.
- **One project only.** The catalog serves only this repo (`mise run catalog`), and its home page lists journeys, while a project can have many intents.

## What this adds

- **Two axes, named apart.** Capture is keyed by the tool that runs the test. Rendering is keyed by the format a reader sees.
  - **Capture adapters** are libraries in the runner's own process.
  - **Evidence plugins** are sandboxed zarg plugins that render kinds into catalog pages.
- **Our plugins do what can be handled generically:**
  - terminals: coloured frames, casts, text, gifs;
  - screens: screenshots, gifs, video, and a trace timeline.

  Anything framework-specific comes from other plugins and adapters through the same contract.
- **Visual evidence now.** The first TUI steps (J-0002) capture coloured frames and casts.
- **A catalog for any project.** `zarg catalog` builds and serves the catalog in whatever project zarg runs in. Its home page lists intents, and the site is redesigned with the `impeccable` design skill.

## Naming

Packages are named by role:
- `agent-*` are agents;
- `provider-*` are providers;
- `evidence-*` are evidence capture and rendering (new);
- `plugin-*` are graph and service plugins.

In the docs, "plugin" means something that runs in the sandbox. Capture packages are "capture adapters".

| Package | Kind | Runs | Provides |
|---|---|---|---|
| `@zarg/evidence-capture` | library | the runner's process | the contract (kinds, `Capture`, the evidence JSON), generic builders, the evidence writer (`/writer`) |
| `@zarg/evidence-capture-xterm` | capture adapter | the runner's process | an xterm buffer → `evidence-terminal/frame`, `/cast`, `/text` |
| `@zarg/evidence-capture-playwright` | capture adapter | the runner's process | a Playwright `page` → `evidence-screen/screenshot`, `/video`, `/trace` |
| `evidence-terminal` (`packages/evidence-terminal`) | evidence plugin | sandbox, at catalog build | renders `frame`, `cast`, `text`, `gif` |
| `evidence-screen` (`packages/evidence-screen`) | evidence plugin | sandbox, at catalog build | renders `screenshot`, `gif`, `video`, `trace` |

More adapters can come later (Cypress, Detox, Appium, …). Each is a thin layer over `@zarg/evidence-capture`'s builders and adds no kinds. A framework-only artifact (a Playwright trace zip's DOM snapshots, an Xcode result bundle) would be its own evidence plugin, such as `evidence-xcode`, with its own kinds.

## The contract (`@zarg/evidence-capture`)

- **A kind** is named `<plugin>/<kind>` (`evidence-terminal/frame`), the same way entity kinds are.
- **The evidence JSON** keeps its shape from plan 1 (`.zarg/evidence/<S-id>.json`), with one change: each medium's `kind` is a kind ref.
  - The old names stay readable as aliases: `buffer` and `log` → `evidence-terminal/text`, `cast` → `evidence-terminal/cast`, `image` → `evidence-screen/screenshot`, `gif` → `evidence-screen/gif`, `video` → `evidence-screen/video`.
  - The audit and the catalog resolve aliases. Old evidence keeps reading.
- **What a capture returns:**
  ```ts
  type Capture = {
    readonly kind: string                                    // "evidence-terminal/frame"
    readonly caption: string
    readonly files: Readonly<Record<string, string | Uint8Array>>   // name → content; the first file is the medium's main file
    readonly meta?: Json
  }
  ```
- **Generic builders,** with no framework dependency, for any runner on any platform:
  - `text(caption, text)`;
  - `screenshot(caption, png)`;
  - `gif(caption, bytes)`;
  - `video(caption, bytes, mime)`;
  - `trace(caption)`, a builder:
    ```ts
    const t = trace("saving a plan")
    t.action("click Save", { screenshot: png, console: [{ level: "error", text: "…" }], requests: [{ method: "POST", url: "/api/save", status: 500, ms: 41 }], ms: 120 })
    t.done()   // → Capture: kind evidence-screen/trace, files trace.json + 001.png …
    ```
- **The writer** (`@zarg/evidence-capture/writer`):
  - `attach(evidenceDir, scenario, capture)` stages files under `media/<S>/`;
  - `write(evidenceDir, evidence)` writes the JSON atomically, with the media swapped in as plan 1 does.

  Our harness's `proves` uses it, and so can any other runner. `@zarg/e2e`'s `Step` gains `attach(capture)`. Its `note` becomes `attach(text(…))`.
- **Text or binary.** A kind declares `files: "text" | "binary"`.
  - Text media is committed. Binary media is gitignored unless `[e2e] media = "commit"`.
  - The integrity check and the catalog's "only committed media" rule read this from the kind's declaration.
  - An undeclared kind is treated as binary.

## Evidence plugins

**A zarg plugin declares the kinds it renders:**
```ts
definePlugin({
  name: "evidence-terminal",
  evidence: { frame: { label: "terminal frame", files: "text" }, cast: { label: "terminal recording", files: "text" }, text: { label: "terminal text", files: "text" }, gif: { label: "terminal gif", files: "binary" } },
  methods: { renderEvidence: … },
  assets: ["dist/assets/asciinema-player.min.js", "dist/assets/asciinema-player.css", "dist/assets/terminal.css"],
  …
})
```

- **Rendering.**
  - **Input:** `{ kind, caption, meta, files: { name → text | base64 }, url: { name → site-relative path } }`.
  - **Output:** `{ html, assets? }`, the names of declared assets the page needs.
  - Rendering runs in the plugin sandbox at catalog build. Its scope is `evidence: true` ("render evidence in the catalog"), granted like any other scope. YOLO and first-party plugins start approved.
- **Safety.**
  - **Sanitizing:** the catalog cleans every rendered fragment. It removes `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, every `on*` attribute, and `javascript:` or `data:text/html` URLs. It keeps `data-*` attributes.
  - **Behaviour** comes only from declared assets: files from the plugin's own checked build, copied to `site/plugins/<name>/`. They wire themselves up through `data-*` attributes.
  - **The result:** a sandboxed plugin can extend pages, but it cannot put arbitrary script in a reader's browser.
- **Unknown kinds.** A kind whose plugin is not installed, not granted, or fails to render shows a plain fallback card: the kind, the caption, links to its files, and why ("rendered by evidence-terminal, not installed"). It never fails the build.
- **What the catalog keeps:** layout, Gherkin, statuses, proof metadata and the gallery order. It no longer knows any media format.

## First-party kinds

**`evidence-terminal`:**

| Kind | Capture (`@zarg/evidence-capture-xterm`) | Render |
|---|---|---|
| `frame` | the xterm buffer's cells with their colours and attributes → `frame.json` (rows of spans: text, fg, bg, bold, italic, underline, inverse) | an inline SVG of the screen in a monospace font, with colours from the frame's own palette; crisp, text, committed, the same bytes for the same screen |
| `cast` | the PTY output since the step began (asciicast v2) | the asciinema player (an asset), with its data in the page so it plays from disk |
| `text` | the screen as text, or a CLI transcript | a monospace block (logs folded) |
| `gif` | the cast rendered by `agg` when it is installed, else not captured | `<img>` |

**`evidence-screen`:**

| Kind | Capture (generic builders; `@zarg/evidence-capture-playwright` from a `page`) | Render |
|---|---|---|
| `screenshot` | PNG bytes | `<img>`, which opens full size |
| `gif` | bytes | `<img>` |
| `video` | bytes and a mime type | `<video controls>` |
| `trace` | `trace.json` and one PNG per action | a timeline: one row per action, with its screenshot, console messages and requests; errors and failed requests marked; a film-strip scrubber over the screenshots |

**The Playwright adapter** is structurally typed. It needs `page.screenshot()`, `page.on("console" | "request" | "response")` and `page.video()?.path()`, so it carries no Playwright dependency and is tested with a fake page.

```ts
const rec = playwright(page)
await rec.action("click Save", () => page.click("text=Save"))
step.attach(rec.trace("saving a plan"))
```

## Visual evidence now

- **J-0002 Set up** gets its first fast-tier TUI steps. Both are router-free:
  - **S-0069, zarg's own plugins start approved:** start zarg in a new project; no grant popover appears for first-party plugins.
  - **S-0067, Operator turns on YOLO:** `/yolo on`; YOLO shows on the status line.
- **What each step captures:** the step's cast, plus coloured `frame`s before and after, through `@zarg/evidence-capture-xterm`.
- **J-0005** is recaptured through the new API. Its transcripts become `evidence-terminal/text`.

## A catalog for any project

- **The commands.**
  - `zarg catalog` builds the catalog and serves it at `http://localhost:4173` (`--port`, `--open`).
  - `zarg catalog build [--out dir]` only builds.
- **Where it goes.** The default output is `.zarg/catalog/`, which holds its own `.gitignore` (`*`). The project's own `.gitignore` is never edited.
- **What it reads:** the project's graph, its `.zarg/evidence`, its git remote (for code links), and its installed evidence plugins. The first-party `evidence-*` load in every project; others come in with `zarg plugin add`.
- **Project name:** the git remote's repo name, else the directory name.
- **In this repo,** `mise run catalog` becomes `zarg catalog`.

### Pages

- **Home is the intent list:**
  - a verdict line (`12 of 66 scenarios proven · 0 failing · 3 stale`, red first);
  - the audit checks as a compact strip;
  - every intent as a row: title, status, number of outcomes, a proof bar over the scenarios its journeys hold, and failing and stale counts. Rows are sorted red first, then by id, with a filter as you type;
  - journeys that serve no outcome, and scenarios in no journey, in their own short section.
- **Intent page:**
  - its problem;
  - each outcome with the journeys serving it, each journey with its proof bar;
  - constraints and what they bound;
  - open questions.
- **Journey page:** the flow as a vertical timeline of scenario cards, with branches side by side and "↺ back to" as a link. Each card shows the persona, title and status, and a thumbnail of its first visual medium (frame, screenshot or trace).
- **Scenario page, in this order:**
  1. on failure, the failure first: expected beside what it saw (the frame or screenshot it failed on);
  2. the Gherkin;
  3. the evidence gallery: visual media large, then text;
  4. code links;
  5. proof metadata (run, commit, time, flaky).
- **Search** sits in the header of every page.

### Design

- **The skill.** The redesign goes through the `impeccable` skill (`context`, then `new-work` on `packages/catalog`). It writes `packages/catalog/DESIGN.md`, so later changes keep the look.
- **Colour.** `@zarg/tokens` stays the colour truth, so the site and the TUI agree on status colours. Type, spacing and layout are the skill's to choose.
- **It keeps what plan 2 guarantees:**
  - relative links (it works under any sub-path);
  - it opens from disk;
  - deterministic bytes;
  - nothing from a CDN;
  - light and dark;
  - only committed media.
- **Checked in a browser** at desktop and phone widths before it is done.

## Order

- **Plan A, the contract:**
  - `@zarg/evidence-capture`: kinds, `Capture`, the builders, the writer, aliases;
  - `definePlugin({ evidence, assets })` and the `evidence: true` scope;
  - the host's `renderEvidence`;
  - in the catalog: the sanitizer, asset copying and the fallback card;
  - `Step.attach`;
  - the audit reading text or binary from the kinds.
- **Plan B, the plugins:**
  - `evidence-terminal` and `@zarg/evidence-capture-xterm`;
  - `evidence-screen` and `@zarg/evidence-capture-playwright`;
  - J-0002's visual steps;
  - J-0005 recaptured.
- **Plan C, the catalog for any project:** `zarg catalog`, `.zarg/catalog/`, the project name, the intent-list home, the pages above, and the redesign through `impeccable` with `DESIGN.md`.
- **Then e2e plan 3 (red becomes work) and plan 4 (coverage, strict).** Plan 4's TUI and web journeys capture through these from the start.

## Out of scope

- Adapters for frameworks other than xterm and Playwright.
- A web runner in `@zarg/e2e`. This repo has no web app; the Playwright adapter is tested with a fake page.
- PNG rasterizing of terminal frames. SVG frames are the visual form; `agg` gifs are optional.
- GitHub Pages publishing (deferred, as in the e2e spec).

## Tests

- **Contract:**
  - each builder's `Capture`;
  - the writer's atomic swap (as in plan 1);
  - aliases read old evidence;
  - text or binary decides integrity and catalog presence.
- **Plugins:**
  - a frame from a known xterm buffer gives the same SVG bytes every time;
  - a cast plays from page data;
  - a trace renders its actions with errors marked;
  - the Playwright adapter turns a fake page's events into a trace.
- **Safety:** a rendering plugin that returns `<script>`, `onerror=` or `javascript:` has them stripped; an ungranted or missing plugin gets the fallback card; an asset outside the plugin's build is refused.
- **Catalog:**
  - `zarg catalog build` in a temp project with no evidence and no remote;
  - an intent list of many intents, red first;
  - a journey card's thumbnail;
  - built twice, the same bytes;
  - a page opened from disk.
