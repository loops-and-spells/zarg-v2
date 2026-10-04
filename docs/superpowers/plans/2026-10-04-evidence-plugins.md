# Evidence Plugins (evidence plan B of 3): terminal and screen, capture adapters, visual steps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-party evidence renders, and the e2e harness captures visual evidence.
- `evidence-terminal` renders coloured terminal frames (SVG), casts (the asciinema player), text and gifs.
- `evidence-screen` renders screenshots, gifs, video and traces (a timeline).
- `@zarg/evidence-capture-xterm` captures frames and casts from an xterm.
- `@zarg/evidence-capture-playwright` captures screenshots, video and traces from a Playwright page.
- The e2e harness attaches frames and casts on every terminal step.
- J-0002 gains its first visual steps (S-0069, S-0067).

**Architecture:**
- **Capture adapters** are plain libraries, used in the runner's process.
- **The two evidence plugins** are sandboxed zarg plugins (`archetype: "service"`, `scopes: { evidence: true }`). Their `renderEvidence` is pure: input files in, HTML out.
- **Assets:**
  - the player JS and CSS come from `asciinema-player` through the plugin's package `node_modules`;
  - `cast.js` and `terminal.css` are the plugin's own;
  - they ship hashed in `dist/assets/` (plan A).
- **Frames are rendered at capture time:** the colours are resolved to hex when the frame is captured, so the renderer only draws.

**Tech Stack:** Bun 1.4, Effect 4, `@xterm/headless` 6 (cell API), `asciinema-player` 3.17.0 (exact pin), bun test.

**Spec:** `docs/superpowers/specs/2026-10-04-evidence-plugins-design.md` ("First-party kinds", "Visual evidence now", "Order: Plan B").

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Sanitizer-proof renders:** everything a renderer returns must survive plan A's sanitizer unchanged. Each renderer's tests assert `await sanitize(html) === html`.
  - No `style` attributes: use classes and SVG presentation attributes.
  - Behaviour comes through `data-*` and the plugin's own assets.
- **Deterministic:** the same capture gives the same bytes, and the same medium renders the same HTML.
- **No framework dependency** in the capture adapters (structural types). `@xterm/headless` is a dependency of the harness, not of the adapter.
- **Text frames are committed** (`frame`, `cast` and `text` are text kinds). Screenshots, gifs, video and trace PNGs are binary (gitignored by default).
- The scenarios say "the operator".

## Review Focus

1. **A frame with wide characters (CJK, emoji) or combining marks.** Expected: columns stay aligned, so a wide cell takes two columns and the next cell starts after it. Task 1 tests it.
2. **A terminal with a 256-colour or truecolor foreground and a default background.** Expected: hex colours as xterm draws them; default cells draw no background rect. Task 1 tests it.
3. **A cast whose text holds `"`, `<`, `&` or newlines in a `data-` attribute.** Expected: it reaches the player intact, never as markup. Task 2 tests it.
4. **A trace action with no screenshot, or a failing request (status ≥ 400) and console errors.** Expected: the row renders, with the failure marked. Task 3 tests it.
5. **A Playwright page whose `screenshot()` rejects mid-action (the page closed).** Expected: the action is recorded with its error and no screenshot, and the trace is still produced. Task 4 tests it.

---

## File Structure

- `packages/evidence-capture-xterm/` (new): `src/index.ts` (`frame`, `cast`, `gif`), `src/palette.ts` (xterm's default 256 colours), tests.
- `packages/evidence-terminal/` (new plugin):
  - `src/index.ts` (`definePlugin`), `src/frame.ts` (frame → SVG), `src/render.ts`;
  - `assets/cast.js`, `assets/terminal.css`;
  - `package.json` (dependency `asciinema-player` 3.17.0), tests.
- `packages/evidence-screen/` (new plugin): `src/index.ts`, `src/render.ts`, `assets/screen.css`, `assets/trace.js`, tests.
- `packages/evidence-capture-playwright/` (new): `src/index.ts` (`record`), tests.
- `packages/catalog/src/model.ts`: passes `text` for `.json`, `.txt` and `.cast` files of any kind (a trace's `trace.json`).
- `packages/e2e/src/term.ts` (`Term.xterm`), `src/proof.ts` (frames and a cast through the adapter); `journeys/J-0002.test.ts` (new).
- `AGENTS.md`: the `evidence-*` package lines and the naming rule.

---

### Task 1: `@zarg/evidence-capture-xterm`: frames, casts, gifs

**Files:**
- Create: `packages/evidence-capture-xterm/{package.json,mise.toml,tsconfig.json,src/index.ts,src/palette.ts,test/index.test.ts}`

**Interfaces:**
- Produces:
```ts
/** What frame() reads of a terminal: xterm's buffer API, structurally. */
export interface XtermLike {
  readonly cols: number
  readonly rows: number
  readonly buffer: { readonly active: { readonly viewportY: number; getLine(y: number): { getCell(x: number): CellLike | undefined } | undefined } }
}
export interface CellLike { getChars(): string; getWidth(): number; getFgColorMode(): number; getFgColor(): number; getBgColorMode(): number; getBgColor(): number; isFgDefault(): boolean; isBgDefault(): boolean; isFgPalette(): boolean; isBgPalette(): boolean; isFgRGB(): boolean; isBgRGB(): boolean; isBold(): number; isItalic(): number; isUnderline(): number; isInverse(): number; isDim(): number }
export type Span = { readonly t: string; readonly fg?: string; readonly bg?: string; readonly b?: true; readonly i?: true; readonly u?: true; readonly d?: true }
export type Frame = { readonly cols: number; readonly rows: number; readonly fg: string; readonly bg: string; readonly lines: ReadonlyArray<ReadonlyArray<Span>> }
export const FG = "#c0c0c0", BG = "#101010"
/** The screen as coloured spans (adjacent cells with the same look merge; inverse is resolved; a wide cell's spacer is skipped). */
export const frameOf: (term: XtermLike) => Frame
export const frame: (caption: string, term: XtermLike) => Capture            // evidence-terminal/frame, "frame.json"
export const cast: (caption: string, asciicast: string) => Capture           // evidence-terminal/cast, "step.cast"
/** A gif of the cast through `agg` when it is on PATH; undefined otherwise. */
export const gif: (caption: string, asciicast: string) => Capture | undefined   // evidence-terminal/gif, "step.gif"
```
- `palette.ts` holds xterm.js's default 16 ANSI colours, the 6×6×6 cube and the 24 greys, as `PALETTE: ReadonlyArray<string>` (256 hex strings).

- [ ] **Step 1: Create the package.** Its dependency is `@zarg/evidence-capture`. Its dev dependency is `@xterm/headless@^6` (tests only).
- [ ] **Step 2: Write the failing tests**, using a real `@xterm/headless` terminal:

```ts
import { expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { BG, FG, frame, frameOf } from "../src"

const term = async (cols: number, rows: number, text: string) => {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  await new Promise<void>((r) => t.write(text, r))
  return t
}

test("a frame: spans merge by look; palette, 256 and truecolor resolve to hex; inverse swaps; defaults draw nothing", async () => {
  const t = await term(12, 2, "\x1b[1;31mok\x1b[0m \x1b[38;5;208mor\x1b[38;2;1;2;3mx\x1b[0m\r\n\x1b[7mInv\x1b[0m")
  const f = frameOf(t)
  expect(f).toMatchObject({ cols: 12, rows: 2, fg: FG, bg: BG })
  expect(f.lines[0]).toEqual([{ t: "ok", fg: "#cd3131", b: true }, { t: " " }, { t: "or", fg: "#ff8700" }, { t: "x", fg: "#010203" }, { t: "     " }])
  expect(f.lines[1]![0]).toEqual({ t: "Inv", fg: BG, bg: FG })
})

test("a wide character takes two columns; the next cell starts after it", async () => {
  const f = frameOf(await term(6, 1, "a界b"))
  expect(f.lines[0]).toEqual([{ t: "a界b" }, { t: "  " }])
  expect(f.lines[0]!.map((s) => s.t).join("")).toBe("a界b  ")
})

test("the same screen gives the same bytes", async () => {
  const a = frame("x", await term(10, 2, "\x1b[32mhi\x1b[0m"))
  const b = frame("x", await term(10, 2, "\x1b[32mhi\x1b[0m"))
  expect(a.files["frame.json"]).toBe(b.files["frame.json"] as string)
  expect(a.kind).toBe("evidence-terminal/frame")
})
```
  Wide characters: xterm gives a width-2 cell followed by a width-0 spacer. The span text keeps the wide character once. The renderer advances x by the cell widths, which it computes from the characters with the same rule (each code point of East Asian Wide/Fullwidth counts 2). To keep this exact, put `cells: number` on every span (the number of columns it covers), and assert `cells` in the test above: `[{ t: "a界b", cells: 4 }, { t: "  ", cells: 2 }]`. Add `cells` to `Span` and to every expected span (`{ t: "ok", fg: "#cd3131", b: true, cells: 2 }` …). The renderer (Task 2) uses `cells`, never `t.length`.
- [ ] **Step 3: Run them and watch them fail.**
- [ ] **Step 4: Implement:**
  - `palette.ts`: the xterm.js defaults (`#000000`, `#cd3131`, `#0dbc79`, `#e5e510`, `#2472c8`, `#bc3fbc`, `#11a8cd`, `#e5e5e5`, then brights `#666666`, `#f14c4c`, `#23d18b`, `#f5f543`, `#3b8eea`, `#d670d6`, `#29b8db`, `#e5e5e5`), then the cube (levels 0, 95, 135, 175, 215, 255) and greys (8 + 10·n).
  - `frameOf`: walk each row's cells.
    1. Skip width-0 cells.
    2. Resolve fg and bg: `isFgRGB` → `#rrggbb` from `getFgColor()`; palette → `PALETTE[n]`; default → none.
    3. Inverse swaps them, defaulting to `FG`/`BG`.
    4. Merge into the previous span when the look is the same.
    5. An empty char counts as a space.
  - `gif`: `Bun.which("agg")`; write the cast to a temp file; run `agg <in> <out>`; read the bytes. When `agg` is missing, answer `undefined`.
- [ ] **Step 5: Run them and watch them pass**, then **commit**:

```bash
mise run verify && git add packages/evidence-capture-xterm bun.lock && git commit -m "feat(evidence-capture-xterm): coloured terminal frames, casts and gifs from an xterm

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `evidence-terminal`: frames as SVG, casts in the player, text, gifs

**Files:**
- Create: `packages/evidence-terminal/{package.json,mise.toml,tsconfig.json,src/index.ts,src/frame.ts,src/render.ts,assets/cast.js,assets/terminal.css,test/render.test.ts}`

**Interfaces:**
- **The plugin** (`definePlugin`):
  - `name: "evidence-terminal"`, `service: "EvidenceTerminal"`, `archetype: "service"`, `config: Schema.Struct({})`, `scopes: { evidence: true }`;
  - `evidence`: `{ frame: { label: "terminal frame", files: "text" }, cast: { label: "terminal recording", files: "text" }, text: { label: "terminal text", files: "text" }, gif: { label: "terminal gif", files: "binary" } }`;
  - `assets: ["node_modules/asciinema-player/dist/bundle/asciinema-player.min.js", "node_modules/asciinema-player/dist/bundle/asciinema-player.css", "assets/cast.js", "assets/terminal.css"]`;
  - `methods.renderEvidence`: params `Schema.Unknown` (a `RenderInput`), success `Schema.Struct({ html: Schema.String, assets: Schema.Array(Schema.String) })`.
- **`render.ts`:**
```ts
export const render: (input: RenderInput) => { readonly html: string; readonly assets: ReadonlyArray<string> }
// frame → frameSvg(JSON.parse(files[0].text)), assets ["terminal.css"]
// cast  → `<div class="evidence-cast" data-cast-data="${esc(text)}"></div>`, assets ["asciinema-player.css", "asciinema-player.min.js", "cast.js"]
// text  → meta.fold ? `<details class="evidence-text"><summary>…</summary><pre>…</pre></details>` : `<pre class="evidence-text">…</pre>`, assets ["terminal.css"]
// gif   → `<img class="evidence-gif" src="${up}${url}" alt="${esc(caption)}">` (url is site-relative; pages live one level down, so up = "../")
```
- **`frame.ts`:** `frameSvg(f: Frame): string`.
  - `viewBox="0 0 {cols*CW} {rows*LH}"` with `CW = 8.4`, `LH = 17`, `class="evidence-frame"`, `font-family="ui-monospace, Menlo, monospace"`, `font-size="14"`.
  - A background `<rect>` filling the whole box with `fill=f.bg`.
  - For each span with a `bg`, a `<rect>` at its column.
  - For each line, one `<text y="{(row+0.8)*LH}" xml:space="preserve">` with a `<tspan x="{col*CW}" fill="…" font-weight="bold">` per span (the spans' own text, escaped).
  - Numbers are printed with `toFixed(1)`, stripped of a trailing `.0`.
- **`cast.js`:** `document.querySelectorAll(".evidence-cast").forEach((el) => AsciinemaPlayer.create({ data: el.dataset.castData }, el, { fit: "width", terminalFontFamily: "ui-monospace, Menlo, monospace" }))`.
- **`terminal.css`:** `.evidence-frame{width:100%;height:auto;border-radius:6px}` and `.evidence-text{…}`.

- [ ] **Step 1: Create the package.** `"asciinema-player": "3.17.0"` (exact), plus `@zarg/plugin-sdk`, `@zarg/evidence-capture`, `@zarg/evidence-capture-xterm` (types only) and `effect`. Run `mise x -- bun install`, then check that `packages/evidence-terminal/node_modules/asciinema-player/dist/bundle/asciinema-player.min.js` resolves. If bun does not link it there, use the path relative to the package that does resolve (`../../node_modules/…`) and record a ruling.
- [ ] **Step 2: Write the failing tests** (`test/render.test.ts`):

```ts
import { expect, test } from "bun:test"
import { sanitize } from "@zarg/catalog"
import { render } from "../src/render"
import { frameSvg } from "../src/frame"

const frame = { cols: 4, rows: 1, fg: "#c0c0c0", bg: "#101010", lines: [[{ t: "o<k", fg: "#cd3131", b: true as const, cells: 3 }, { t: " ", bg: "#2472c8", cells: 1 }]] }

test("a frame draws as SVG: its background, each span's colour at its column, text escaped; the same frame, the same bytes", async () => {
  const svg = frameSvg(frame)
  expect(svg).toContain('viewBox="0 0 33.6 17"')
  expect(svg).toContain('<rect x="0" y="0" width="33.6" height="17" fill="#101010"/>')
  expect(svg).toContain('<rect x="25.2" y="0" width="8.4" height="17" fill="#2472c8"/>')
  expect(svg).toContain('<tspan x="0" fill="#cd3131" font-weight="bold">o&lt;k</tspan>')
  expect(frameSvg(frame)).toBe(svg)
  expect(await sanitize(svg)).toBe(svg)
})

test("a cast's text reaches the player through a data attribute, intact; its assets are the player's and ours", async () => {
  const text = `{"version":2}\n[0.1,"o","say \\"<hi>\\" & go"]\n`
  const r = render({ kind: "evidence-terminal/cast", caption: "step", files: [{ name: "step.cast", url: "media/S-1/step.cast", text }] })
  expect(r.assets).toEqual(["asciinema-player.css", "asciinema-player.min.js", "cast.js"])
  expect(await sanitize(r.html)).toBe(r.html)
  const el = new HTMLRewriter()
  let got = ""
  await el.on("div", { element(e) { got = e.getAttribute("data-cast-data") ?? "" } }).transform(new Response(r.html)).text()
  expect(got).toBe(text)
})

test("text folds when asked; a gif is an image", async () => {
  const folded = render({ kind: "evidence-terminal/text", caption: "git log", meta: { fold: true }, files: [{ name: "t.txt", url: "m/t.txt", text: "a <b>" }] })
  expect(folded.html).toBe('<details class="evidence-text"><summary>git log</summary><pre>a &lt;b&gt;</pre></details>')
  expect(render({ kind: "evidence-terminal/gif", caption: "g", files: [{ name: "s.gif", url: "media/S-1/s.gif" }] }).html).toBe('<img class="evidence-gif" src="../media/S-1/s.gif" alt="g">')
  for (const r of [folded]) expect(await sanitize(r.html)).toBe(r.html)
})
```
  `getAttribute` in HTMLRewriter returns the attribute decoded. If it returns the raw (escaped) form instead, decode it with the same table `esc` uses, and record a ruling. The point is the round trip, not the API.
  `@zarg/catalog` is a dev dependency of the plugin's tests only. The bundle must not import it; the import rule forbids nothing here, because catalog is not a plugin.
- [ ] **Step 3: Run them and watch them fail.**
- [ ] **Step 4: Implement** `frame.ts`, `render.ts`, the assets, and `index.ts` (whose `make` returns `{ renderEvidence: (input) => Effect.succeed(render(input)) }`). Add `evidence-terminal` to the root `mise.toml` nothing more; `build-plugins.ts` already lists it.
- [ ] **Step 5: Run them and watch them pass.** Then run `mise run build:plugins`: `packages/evidence-terminal/dist/assets/` should hold four files and the manifest should hash them. Then run `mise run -q zarg -- catalog build --out <scratchpad>/site`: J-0005's text media now render as `<pre class="evidence-text">` (no fallback cards).
- [ ] **Step 6: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/evidence-terminal packages/plugin/src/server/first-party-hashes.ts bun.lock && git commit -m "feat(evidence-terminal): terminal frames as SVG, casts in the player, text and gifs in the catalog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `evidence-screen`: screenshots, gifs, video, traces

**Files:**
- Create: `packages/evidence-screen/{package.json,mise.toml,tsconfig.json,src/index.ts,src/render.ts,assets/screen.css,assets/trace.js,test/render.test.ts}`
- Modify: `packages/catalog/src/model.ts` and its test (text for `.json`/`.txt`/`.cast` files of any kind)

**Interfaces:**
- **The plugin** is like Task 2, with `name: "evidence-screen"`.
  - `evidence`: `screenshot` ("screenshot"), `gif` ("animation"), `video` ("video") and `trace` ("trace"), all `binary`.
  - `assets: ["assets/screen.css", "assets/trace.js"]`.
- **`render.ts`:**
  - `screenshot` and `gif` → `<a class="evidence-shot" href="../{url}"><img src="../{url}" alt="{caption}" loading="lazy"></a>`;
  - `video` → `<video class="evidence-video" controls preload="metadata" src="../{url}"></video>`;
  - `trace` → a timeline. Each `trace.json` action becomes `<li class="evidence-step{ failed ? " failed" : ""}" data-step="{i}">` holding:
    - the action name and ms;
    - the screenshot (`<img src="../{url of meta.files entry}">`, matching on the file name's `-NNN.png`);
    - console lines (`error` marked);
    - requests (status ≥ 400 marked).

    A film strip (`<div class="evidence-strip">` of thumbnails) goes on top. `trace.js` scrubs: clicking a thumbnail scrolls to its step.

    "failed" means any console `error` or any request with status ≥ 400.

- [ ] **Step 1: Write the failing tests.**
  - Screenshot, gif and video HTML exactly as above.
  - A trace from the plan A builder's output, attached the way plan A's writer names files (`2-trace.json`, with `meta.files` `["media/S-1/2-001.png"]`): two actions, the second with a 500 and an error.
    - The HTML has two `evidence-step` items.
    - The second has class `failed` and shows `POST /api/save` with `500`.
    - An action without a screenshot has no `<img>`.
  - Every render survives `sanitize` unchanged.
  - A catalog model test: a `trace.json` medium's file carries `text`, even though the kind is binary.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** In `catalog/src/model.ts`, a file gets `text` when its kind is text **or** its name ends `.json`, `.txt` or `.cast`.
- [ ] **Step 4: Run them and watch them pass**, then `mise run build:plugins`.
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/evidence-screen packages/catalog packages/plugin/src/server/first-party-hashes.ts bun.lock && git commit -m "feat(evidence-screen): screenshots, gifs, video and trace timelines in the catalog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `@zarg/evidence-capture-playwright`

**Files:**
- Create: `packages/evidence-capture-playwright/{package.json,mise.toml,tsconfig.json,src/index.ts,test/index.test.ts}`

**Interfaces:**
- Produces:
```ts
/** What record() uses of a Playwright page, structurally (no dependency). */
export interface PageLike {
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>
  on(event: "console", fn: (m: { type(): string; text(): string }) => void): unknown
  on(event: "requestfinished" | "requestfailed", fn: (r: { method(): string; url(): string; response(): Promise<{ status(): number } | null>; timing?(): { responseEnd: number } }) => void): unknown
  video?(): { path(): Promise<string> } | null
}
export const record: (page: PageLike) => {
  /** Runs `fn`, then records the action: its screenshot, and the console and requests seen during it. */
  readonly action: (name: string, fn: () => Promise<unknown>) => Promise<void>
  readonly screenshot: (caption: string) => Promise<Capture>
  readonly trace: (caption: string) => Capture
  /** The page's video (call after the page closes). */
  readonly video: (caption: string) => Promise<Capture | undefined>
}
```
- **Behaviour:**
  - `action` collects console messages and requests from the moment it starts until `fn` settles, then takes a screenshot.
    - If `fn` throws, the action is recorded with a console line `{ level: "error", text: "action failed: <message>" }` and the error is rethrown.
    - If the screenshot throws, the action has no screenshot.
  - A failed request (`requestfailed`) records status 0.
  - Each action's `ms` is its own duration.

- [ ] **Step 1: Write the failing tests** with a fake page (an `EventEmitter`-like object):
  - two actions, one that emits a console error and a 500 response; the trace's JSON has both, in order;
  - an action whose `fn` throws: recorded, then rethrown;
  - a page whose `screenshot` rejects: the action is recorded without a screenshot;
  - `video` with no `video()` answers `undefined`.
- [ ] **Step 2: Run them and watch them fail. Implement. Run them and watch them pass.** `ms` comes from `performance.now()`. The tests check `ms` is a number ≥ 0, never its value.
- [ ] **Step 3: Commit**

```bash
mise run verify && git add packages/evidence-capture-playwright bun.lock && git commit -m "feat(evidence-capture-playwright): screenshots, video and traces from a Playwright page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The harness captures frames; J-0002's visual steps

**Files:**
- Modify: `packages/e2e/src/term.ts` (`Term.xterm`), `packages/e2e/src/proof.ts`, `packages/e2e/package.json`
- Create: `packages/e2e/journeys/J-0002.test.ts`
- Modify: `.zarg/evidence` (J-0002 new, J-0005 refreshed), `AGENTS.md`

**Interfaces:**
- **`Term`** gains `readonly xterm: XtermLike` (the headless terminal) and `readonly castFrom: (from: number) => string` (the cast from event `from` on).
- **On a step with a terminal open**, `proves` attaches, in order:
  1. `frame("the screen before", term.xterm)`;
  2. the step's own captures;
  3. `frame("the screen after", term.xterm)`;
  4. `cast("the step as it played", …)`;
  5. `gif(…)` when `agg` is on PATH.
- **The failure's `saw`** stays the screen as text.

- [ ] **Step 1: Write the journey** (`journeys/J-0002.test.ts`, fast tier). Find the exact keys and screen texts first by running the TUI in a world and reading `t.screen()`, as the plan 1 harness test does.

```ts
import { expect } from "bun:test"
import { journey } from "../src"

journey("J-0002", { tier: "fast" }, (proves) => {
  proves("S-0069", async (s) => {
    const t = await s.open()
    await t.waitFor("not set up", 30_000)      // first run: the Setup sheet over the inbox
    t.press("esc")
    await t.waitFor(/Inbox/)
    // zarg's own plugins that only touch the graph started approved; the others ask.
    const agenda = (await s.cli(["agenda"])).json as ReadonlyArray<{ id: string }>
    s.note("buffer", "zarg agenda", JSON.stringify(agenda.map((a) => a.id), null, 2))
    const ids = agenda.map((a) => a.id)
    expect(ids).not.toContain("plugin-grant:gherkin")
    expect(ids).not.toContain("plugin-grant:evidence-terminal")
    expect(ids).toContain("plugin-grant:backlog")
  })
  proves("S-0067", async (s) => {
    const t = s.term!
    t.type("/yolo on")
    t.press("enter")
    await t.waitFor("YOLO")
    expect(t.screen()).toMatch(/YOLO/)
  })
})
```
  A first-party plugin still waiting in the TUI shows a grant popover on top of the inbox. Wait for and record whatever the screen shows. If the popover is the first thing visible, `S-0069`'s point is exactly that gherkin did not raise one, so assert the popover names a non-graph plugin (`backlog`, …) and never `gherkin`, then dismiss it as the screen says.
- [ ] **Step 2: Run it**: `mise run e2e -- J-0002`. Fix the step's expectations from what the screen really shows. A product bug found here gets its own test and fix in its package, recorded in the ledger.
- [ ] **Step 3: The harness.**
  - Add `xterm` and `castFrom` to `term.ts`.
  - In `proof.ts`, replace the before and after `text(…)` with `frame(…)`, and the cast capture with `cast(…)` from `@zarg/evidence-capture-xterm`. Add `gif`.
  - Run `cd packages/e2e && mise x -- bun test ./test` (the harness tests pass), then `mise run e2e` (J-0002 and J-0005 pass).
- [ ] **Step 4: Check the catalog.** Run `mise run -q zarg -- catalog build --out <scratchpad>/site`, then:
  - `scenarios/S-0069.html` shows two SVG frames (`class="evidence-frame"`) and a cast element;
  - `plugins/evidence-terminal/` holds four assets.

  Serve it, look at it in a browser at desktop and phone widths, and record what you saw in the ledger.
- [ ] **Step 5: Docs.** In `AGENTS.md`:
  - the naming line becomes: `agent-*` agents, `provider-*` providers, `evidence-*` evidence capture and rendering, `plugin-*` graph and service plugins;
  - add a line each for `packages/evidence-capture` (the contract, builders, writer), `evidence-capture-xterm`, `evidence-capture-playwright` (capture adapters, libraries in the runner's process), `evidence-terminal` and `evidence-screen` (evidence plugins: what they render, `renderEvidence`, scope `evidence`, assets).
- [ ] **Step 6: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/e2e .zarg/evidence AGENTS.md && git commit -m "feat(e2e): terminal steps capture coloured frames and casts; J-0002's first visual steps (S-0069, S-0067)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage, plan B:**
  - `evidence-terminal` (frame SVG, cast player, text, gif via `agg`): Tasks 1 and 2;
  - `evidence-screen` (screenshot, gif, video, trace timeline): Task 3;
  - the xterm and Playwright capture adapters: Tasks 1 and 4;
  - J-0002's visual steps (S-0069, S-0067) and J-0005 refreshed: Task 5;
  - the AGENTS.md naming: Task 5.
- **Deferred to plan C:** the catalog for any project, the intent-list home, thumbnails on journey cards, and the redesign through `impeccable`.
- **Placeholders:**
  - Task 1's span `cells` is settled in its step.
  - Task 5's screen texts are found at run time by design: the TUI's exact strings are what the step proves. The plan says how to find them and what each step must assert.
- **Types:**
  - `Frame` and `Span` (with `cells`) from Task 1 are used in Task 2;
  - `RenderInput` is plan A's;
  - `Capture` is from `@zarg/evidence-capture`;
  - `XtermLike` is used by `Term.xterm` (Task 5).
