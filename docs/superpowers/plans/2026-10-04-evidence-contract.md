# Evidence Contract (evidence plan A of 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evidence becomes open. Any runner captures through `@zarg/evidence-capture` (kinds, `Capture`, builders, the writer). Any zarg plugin can declare evidence kinds, ship assets and render its kinds into catalog pages through `renderEvidence`. The catalog sanitizes what plugins render, copies their assets, and shows a fallback card for any kind it cannot render. After this plan the catalog knows no media format itself. Plan B adds the first-party renderers.

**Architecture:**
- **`@zarg/evidence-capture`** (new):
  - pure core: the evidence types moved out of `@zarg/audit/evidence`, kind refs and aliases, `Capture`, the builders;
  - `/writer`: the fs part, moved out of `@zarg/e2e`'s `proof.ts`.
- **SDK and runtime:**
  - `definePlugin({ evidence, assets })`, a manifest `evidence` and `assets` (with sha256 hashes), and the scope `evidence: true`;
  - the build copies assets into `dist/assets/`, and loading or installing checks their hashes.
- **The host** gains an `evidence` member: the kinds registry, and `render(ref, input)`.
- **The audit** reads text or binary from the kinds through a function the CLI supplies.
- **The catalog:**
  - a sanitizer (Bun's `HTMLRewriter`, allowlist);
  - fragments rendered ahead of time by the CLI through the host;
  - asset copying under `plugins/<name>/`;
  - a fallback card.

**Tech Stack:** Bun 1.4 (`HTMLRewriter`), Effect 4, bun test, mise.

**Spec:** `docs/superpowers/specs/2026-10-04-evidence-plugins-design.md` (sections "The contract", "Evidence plugins", "Order: Plan A").

## Global Constraints

- `mise run build:plugins && mise run verify` passes before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Kinds** are `<plugin>/<kind>`, with the kind in kebab-case. Aliases: `buffer` and `log` → `evidence-terminal/text`, `cast` → `evidence-terminal/cast`, `image` → `evidence-screen/screenshot`, `gif` → `evidence-screen/gif`, `video` → `evidence-screen/video`.
- **Text or binary:** a kind's `files` is `"text" | "binary"`. An undeclared kind counts as binary. Text media is committed. Binary media is gitignored unless `[e2e] media = "commit"`. The aliases' targets count as declared (frame, cast, text: text; screenshot, gif, video, trace: per the spec) even before plan B's plugins exist: `@zarg/evidence-capture` ships `FIRST_PARTY_KINDS` for that.
- **Never in rendered HTML:**
  - the elements `script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`, `style`, `form`, `input`, `textarea`, `button`;
  - any `on*` attribute;
  - URLs other than relative, `#`, or `data:image/(png|gif|jpeg|webp)`.
- **Assets** are only files the plugin declared, from its checked build (their hashes are in its manifest).
- **The scope `evidence: true`** declares "renders evidence in the catalog". It needs no net, fs or secrets, so it does not stop first-party auto-approval.
- **The catalog's existing guarantees still hold:** deterministic, relative links, opens from disk, nothing from a CDN, only committed media.

## Review Focus

1. **A plugin returns `<scr<script>ipt>` or `<svg><script>`, or `<a href=" javascript:…">` (leading space, mixed case), or `<img src=x onerror=…>`, or `<use href="http://…">`.** Expected: nothing executable or remote survives. Task 6 tests these.
2. **A plugin's asset file is changed after build (a tampered `dist/assets/x.js`).** Expected: the plugin does not load, and the error names the asset. Task 3 tests it.
3. **A rendering plugin hangs or throws, or returns a non-string.** Expected: that medium gets the fallback card with the reason, and the build still finishes. Task 4 tests it.
4. **Old evidence (kinds `buffer`, `cast`, …) after this plan.** Expected: it reads, and it counts as text or binary through the aliases. J-0005's committed evidence stays valid with no rerun. Task 1 tests it.
5. **Two plugins declare the same kind ref** (impossible, since the ref carries the plugin name), **or a kind is declared without a `renderEvidence` method.** Expected: `definePlugin` refuses it. Task 3 tests it.

---

## File Structure

- `packages/evidence-capture/`:
  - `src/index.ts`: types, kinds, aliases, `FIRST_PARTY_KINDS`, `isText`, `Capture`, the builders;
  - `src/writer.ts`: `stage`, `attach`, `commit`;
  - tests.
- `packages/audit/src/evidence.ts`: re-exports the types from `@zarg/evidence-capture`; `integrity` takes `isText`.
- `packages/e2e/src/proof.ts`: uses the writer; `Step.attach`; `note` becomes `attach(text(…))`.
- `packages/plugin-sdk/src/define.ts`, `manifest.ts`, `build.ts`: `evidence`, `assets`, `Scopes.evidence`.
- `packages/plugin/src/runtime/grants.ts`: `ManifestScopes.evidence`.
- `packages/plugin/src/server/loaded.ts`, `install.ts`: the manifest fields; assets checked on load and copied on install.
- `packages/plugin/src/server/host.ts`: `scopeWords`, the `evidence` member.
- `packages/plugin/scripts/build-plugins.ts`: writes `dist/assets/`.
- `packages/catalog/src/sanitize.ts` (new), plus `model.ts`, `pages.ts`, `build.ts`.
- `packages/cli/src/commands.ts`: `catalog build` renders through the host; `audit` passes `isText`.

---

### Task 1: `@zarg/evidence-capture`: kinds, captures, builders

**Files:**
- Create: `packages/evidence-capture/{package.json,mise.toml,tsconfig.json,src/index.ts,test/index.test.ts}`
- Modify: `packages/audit/src/evidence.ts` (types from here), `packages/audit/package.json`

**Interfaces:**
- Produces:
```ts
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json }
export type Media = { readonly kind: string; readonly path: string; readonly caption: string; readonly meta?: Json }
export type Evidence = { scenario; version; commit; run; journey; passed; flaky; at; ms; media: ReadonlyArray<Media>; failure; code? }   // as in @zarg/audit today, kind widened to string, meta added
export const EVIDENCE_DIR = ".zarg/evidence"
export type KindDecl = { readonly label: string; readonly files: "text" | "binary" }
export const ALIASES: Readonly<Record<string, string>>        // buffer, log, cast, image, gif, video → refs
export const FIRST_PARTY_KINDS: Readonly<Record<string, KindDecl>>   // evidence-terminal/{frame,cast,text,gif}, evidence-screen/{screenshot,gif,video,trace}
export const resolveKind: (kind: string) => string            // alias → ref; a ref stays
export const isKindRef: (s: string) => boolean                // /^[a-z0-9-]+\/[a-z0-9-]+$/
/** text or binary, from the declared kinds (plugins' and the first-party table); undeclared: binary. */
export const isText: (declared: Readonly<Record<string, KindDecl>>) => (kind: string) => boolean
export type Capture = { readonly kind: string; readonly caption: string; readonly files: Readonly<Record<string, string | Uint8Array>>; readonly meta?: Json }
export const text: (caption: string, body: string, opts?: { readonly fold?: boolean }) => Capture       // evidence-terminal/text, file "text.txt", meta { fold }
export const screenshot: (caption: string, png: Uint8Array) => Capture                                   // evidence-screen/screenshot, "screenshot.png"
export const gif: (caption: string, bytes: Uint8Array) => Capture                                         // evidence-screen/gif, "anim.gif"
export const video: (caption: string, bytes: Uint8Array, mime: string) => Capture                         // evidence-screen/video, "video.<ext from mime>", meta { mime }
export type TraceAction = { readonly action: string; readonly screenshot?: Uint8Array; readonly console?: ReadonlyArray<{ readonly level: string; readonly text: string }>; readonly requests?: ReadonlyArray<{ readonly method: string; readonly url: string; readonly status: number; readonly ms?: number }>; readonly ms?: number }
export const trace: (caption: string) => { readonly action: (name: string, a?: Omit<TraceAction, "action">) => void; readonly done: () => Capture }   // files: trace.json + 001.png …
```

- [ ] **Step 1: Create the package** (in the style of `packages/catalog`): no dependencies, `exports` `"."` and `"./writer"`, a `test` task `mise x -- bun test ./test`.
- [ ] **Step 2: Write the failing tests** (`test/index.test.ts`)

```ts
import { expect, test } from "bun:test"
import { ALIASES, FIRST_PARTY_KINDS, isKindRef, isText, resolveKind, screenshot, text, trace, video } from "../src"

test("old kinds read through their aliases; refs stay", () => {
  expect(["buffer", "log", "cast", "image", "gif", "video"].map(resolveKind)).toEqual(["evidence-terminal/text", "evidence-terminal/text", "evidence-terminal/cast", "evidence-screen/screenshot", "evidence-screen/gif", "evidence-screen/video"])
  expect(resolveKind("evidence-x/thing")).toBe("evidence-x/thing")
  expect(Object.values(ALIASES).every(isKindRef)).toBe(true)
  expect(isKindRef("Bad/Kind")).toBe(false)
})

test("text or binary: declared kinds, the first-party table, aliases; undeclared is binary", () => {
  const t = isText({ "evidence-x/notes": { label: "notes", files: "text" } })
  expect([t("evidence-x/notes"), t("buffer"), t("cast"), t("evidence-terminal/frame"), t("image"), t("evidence-screen/trace"), t("evidence-y/unknown")]).toEqual([true, true, true, true, false, false, false])
  expect(FIRST_PARTY_KINDS["evidence-terminal/frame"]).toEqual({ label: "terminal frame", files: "text" })
})

test("builders: a capture is a kind, a caption and its files", () => {
  expect(text("zarg agenda", "$ zarg agenda\n[]", { fold: true })).toEqual({ kind: "evidence-terminal/text", caption: "zarg agenda", files: { "text.txt": "$ zarg agenda\n[]" }, meta: { fold: true } })
  const png = new Uint8Array([137, 80, 78, 71])
  expect(screenshot("home", png)).toEqual({ kind: "evidence-screen/screenshot", caption: "home", files: { "screenshot.png": png } })
  expect(video("run", png, "video/webm")).toMatchObject({ kind: "evidence-screen/video", files: { "video.webm": png }, meta: { mime: "video/webm" } })
})

test("a trace: one entry per action, its screenshots numbered", () => {
  const t = trace("saving a plan")
  t.action("open /plans", { screenshot: new Uint8Array([1]), ms: 80 })
  t.action("click Save", { screenshot: new Uint8Array([2]), console: [{ level: "error", text: "boom" }], requests: [{ method: "POST", url: "/api/save", status: 500, ms: 41 }] })
  const c = t.done()
  expect(c.kind).toBe("evidence-screen/trace")
  expect(Object.keys(c.files)).toEqual(["trace.json", "001.png", "002.png"])
  expect(JSON.parse(c.files["trace.json"] as string)).toEqual([
    { action: "open /plans", screenshot: "001.png", console: [], requests: [], ms: 80 },
    { action: "click Save", screenshot: "002.png", console: [{ level: "error", text: "boom" }], requests: [{ method: "POST", url: "/api/save", status: 500, ms: 41 }] },
  ])
})
```

- [ ] **Step 3: Run them and watch them fail**: `cd packages/evidence-capture && mise x -- bun test ./test`. Expected: FAIL, because the module is not found.
- [ ] **Step 4: Implement `src/index.ts`.**
  - **Types:** move `Media`, `Evidence` and `EVIDENCE_DIR` here from `packages/audit/src/evidence.ts`. Widen `Media.kind` to `string` and add `meta?`.
  - **`FIRST_PARTY_KINDS`:**
    - `frame`, `cast` and `text` are `"text"` (labels "terminal frame", "terminal recording", "terminal text");
    - terminal `gif` is `"binary"` ("terminal gif");
    - screen `screenshot`, `gif`, `video` and `trace` are `"binary"` ("screenshot", "animation", "video", "trace").
  - **`isText(declared)(kind)`:** resolve the alias, look in `declared` then `FIRST_PARTY_KINDS`, and answer `files === "text"`.
  - **Trace omissions:** a trace action without a screenshot leaves the `screenshot` key out. `console` and `requests` default to `[]`, and `ms` is left out when not given.
  - **Video extension:** `video/webm` → `webm`, `video/mp4` → `mp4`, else `bin`.
- [ ] **Step 5: The audit takes the types from here.**
  - `packages/audit/src/evidence.ts` imports `Media`, `Evidence` and `EVIDENCE_DIR` from `@zarg/evidence-capture` and re-exports them. Keep `MediaKind` as `string` for compatibility.
  - Add the dependency, then `mise x -- bun install`.
  - Run `cd packages/audit && mise x -- bun test && mise x -- bunx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 6: Run them and watch them pass**, then **commit**:

```bash
mise run verify && git add packages/evidence-capture packages/audit bun.lock && git commit -m "feat(evidence-capture): kinds, aliases, captures and builders any runner can use

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The writer, and `Step.attach`

**Files:**
- Create: `packages/evidence-capture/src/writer.ts`, `packages/evidence-capture/test/writer.test.ts`
- Modify: `packages/e2e/src/proof.ts` (use the writer; `Step.attach`; `note` → `attach(text(…))`), `packages/e2e/package.json`

**Interfaces:**
- Produces, in `@zarg/evidence-capture/writer`:
```ts
/** One attempt's media, staged beside the evidence until commit: a run killed mid-step leaves the last evidence whole. */
export interface Staged { readonly attach: (c: Capture) => Media; readonly media: () => ReadonlyArray<Media> }
export const stage: (evidenceDir: string, scenario: string, attempt: string) => Staged
/** Swaps the staged media in and writes the evidence atomically (JSON last); clears staging left by killed runs. */
export const commit: (evidenceDir: string, staged: Staged | undefined, evidence: Evidence) => void
export const clearStale: (evidenceDir: string, scenario: string) => void
```
- Media paths are `media/<S>/<n>-<file>`, for example `media/S-0001/1-text.txt`, `2-frame.json`. The attach order prefix keeps two captures with the same file name apart. A capture's first file is its `path`.
- **Multi-file captures (a trace):** `path` is the first file, and `meta.files` lists the others as paths relative to the evidence dir, so renderers find `002.png`.
- `Step.attach(capture)` returns the `Media`. `Step.note(kind, caption, text)` stays as a thin wrapper, `attach(text(caption, text, { fold: kind === "log" }))`, so J-0005 is untouched.

- [ ] **Step 1: Write the failing test** (`writer.test.ts`):
  - attach a `text` capture and a trace with two screenshots, then commit;
  - the JSON lists the media with the paths above, and the files exist with their bytes;
  - `meta.files` lists the trace's PNGs;
  - after a second stage of the same scenario that is never committed (a killed run), `clearStale` removes its staging, and the committed evidence and its media are unchanged.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `writer.ts`** by moving the staging, swap and atomic write out of `packages/e2e/src/proof.ts`. Keep their comments and the `ponytail:` note on rm-then-rename.
- [ ] **Step 4: Point `proof.ts` at the writer.**
  - `put` becomes `staged.attach(capture)`.
  - The before and after screens and the step cast keep their current kinds through captures: `text("the screen before", screen())` and a `{ kind: "evidence-terminal/cast", files: { "step.cast": … } }`. Plan B swaps these for the xterm adapter.
  - Add `attach` to `Step`.
- [ ] **Step 5: Run them and watch them pass**: `cd packages/evidence-capture && mise x -- bun test ./test`, then `cd ../e2e && mise x -- bun test ./test` (the 18 harness tests still pass), then `mise run e2e` (J-0005 passes). Its evidence now has new media paths and kind refs, so commit the refreshed `.zarg/evidence` with this task.
- [ ] **Step 6: Commit**

```bash
mise run verify && git add packages/evidence-capture packages/e2e .zarg/evidence bun.lock && git commit -m "feat(evidence-capture): the evidence writer any runner can use; the e2e harness attaches captures

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Plugins declare evidence kinds and ship assets

**Files:**
- Modify:
  - `packages/plugin-sdk/src/define.ts`, `manifest.ts`, `build.ts`;
  - `packages/plugin/src/runtime/grants.ts`;
  - `packages/plugin/src/server/loaded.ts`, `install.ts`, `host.ts` (`scopeWords`);
  - `packages/plugin/scripts/build-plugins.ts`.
- Test: `packages/plugin-sdk/test/evidence.test.ts`, `packages/plugin/test/assets.test.ts`

**Interfaces:**
- **`PluginDef` gains:**
  - `evidence?: Readonly<Record<string, { readonly label: string; readonly files: "text" | "binary" }>>`;
  - `assets?: ReadonlyArray<string>`, paths relative to the plugin's package (its `src/index.ts`'s parent's parent).
- **`Scopes` and `ManifestScopes` gain** `evidence?: boolean`.
- **`Manifest` gains** `evidence?: Record<kind, { label, files }>` and `assets?: Record<string, string>` (file name → sha256 hex). The host's copy in `loaded.ts` gains the same fields.
- **`definePlugin` refuses:**
  - `evidence` without a `renderEvidence` method: `plugin <name>: evidence kinds need a renderEvidence method`;
  - a kind not in kebab-case;
  - `files` not `text` or `binary`;
  - `evidence` without `scopes.evidence === true`: `plugin <name>: evidence kinds need scopes.evidence`.
- **`buildPlugin` returns** `assets: ReadonlyArray<{ name: string; path: string }>` (absolute source paths). Each name is the file's base name. Two assets with the same name are refused.
- **`build-plugins.ts`:**
  - writes `dist/assets/<name>`;
  - writes the hashes into the manifest's `assets`;
  - adds `evidence-terminal` and `evidence-screen` to `FIRST_PARTY` when their directories exist (they come in plan B; the list skips missing ones already).
- **`loadPluginDir`:** for each manifest asset, read `dist/assets/<name>` and compare its sha256. A mismatch or a missing file gives `PluginConfigError("<dir>: asset <name> does not match its manifest")`. `LoadedPlugin` gains `assets: Record<name, absolutePath>`.
- **`install.ts`** copies `assets/` too, and checks the hashes the same way.
- **`scopeWords`:** `evidence` → "render evidence in the catalog". `graphOnly` is unchanged, so `evidence` stays allowed for first-party auto-approval.

- [ ] **Step 1: Write the failing tests.**
  - **`plugin-sdk/test/evidence.test.ts`:**
    - `definePlugin` with `evidence` but no `renderEvidence` throws the first message, and without `scopes.evidence` the second;
    - a kind `Frame` is refused;
    - `manifestOf` of a valid one carries `evidence` and `scopes.evidence`.
  - **`plugin/test/assets.test.ts`:**
    - build a fixture plugin under `test/fixtures/.gen` (the existing helper) with `assets: ["assets/x.css"]`;
    - write its dist the way `build-plugins.ts` does (factor that writing into an exported `writeDist(pkgDir, result)` in `plugin-sdk/tools`, used by both);
    - `loadPluginDir` loads it with `assets.x.css` pointing at the file;
    - after changing a byte of `dist/assets/x.css`, it fails with `asset x.css does not match its manifest`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, following the interfaces above. `writeDist` does the following:
  1. `mkdir dist` and `dist/assets`;
  2. write the bundle;
  3. copy each asset;
  4. write the manifest with `assets: { name: sha256 }`;
  5. return the hash list `build-plugins.ts` already records.
- [ ] **Step 4: Run them and watch them pass**: `cd packages/plugin-sdk && mise x -- bun test`, `cd ../plugin && mise x -- bun test`, plus `tsc` for both, then `mise run build:plugins`. The first-party manifests are unchanged apart from `scopes` keys, and the hashes regenerate.
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/plugin-sdk packages/plugin && git commit -m "feat(plugin): plugins declare evidence kinds and ship checked assets; scope evidence

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The host renders evidence

**Files:**
- Modify: `packages/plugin/src/server/host.ts`
- Test: `packages/plugin/test/evidence-host.test.ts`

**Interfaces:**
- **`PluginHost` gains:**
```ts
readonly evidence: {
  /** Every running plugin's declared kinds, by ref. */
  readonly kinds: () => Readonly<Record<string, { readonly owner: string; readonly label: string; readonly files: "text" | "binary" }>>
  /** A medium's HTML from the plugin that owns its kind; never fails: a reason instead. */
  readonly render: (input: RenderInput) => Effect.Effect<Rendered>
}
export type RenderInput = { readonly kind: string; readonly caption: string; readonly meta?: unknown; readonly files: ReadonlyArray<{ readonly name: string; readonly url: string; readonly text?: string }> }
export type Rendered =
  | { readonly ok: true; readonly owner: string; readonly html: string; readonly assets: ReadonlyArray<{ readonly name: string; readonly path: string }> }
  | { readonly ok: false; readonly reason: string }
```
- **`render`, step by step:**
  1. Resolve the kind (alias → ref).
  2. Find its owner among the running plugins. If none: `rendered by <plugin>, not installed`, or `not granted` when the plugin is in `waiting`.
  3. Call the owner's `renderEvidence(input)` through the internal `invoke`, with a 10 s deadline.
  4. Check the result's shape: `{ html: string, assets?: string[] }`.
  5. Each asset named must be in the owner's manifest `assets`, else `asset <name> is not one evidence-x declared`.
  6. A failure or deadline gives `{ ok: false, reason: "<plugin> could not render <kind>: <message>" }`.

- [ ] **Step 1: Write the failing tests.** Use the `assets.test.ts` fixture helper to build three plugins:
  - `evidence-good` declares `note` (text), has asset `n.css`, and renders `<p class="n">${files[0].text}</p>` with `assets: ["n.css"]`;
  - `evidence-bad` throws;
  - `evidence-sly` returns `assets: ["../../etc/passwd"]`.

  Make a host over them, first-party trust stubbed true. Assert:
  - `kinds()` lists the three plugins' kinds;
  - `render` of `evidence-good/note` is `ok` with the HTML and the asset's absolute path;
  - `evidence-bad/…` is not ok, with its message;
  - `evidence-sly/…` is not ok: "is not one evidence-sly declared";
  - `evidence-missing/x` is not ok: "rendered by evidence-missing, not installed".
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement it in `host.ts`,** beside the entities registry. Rebuild the kinds map whenever the running set changes, the same way `registry(manifests)` is rebuilt.
- [ ] **Step 4: Run them and watch them pass**, then **commit**:

```bash
mise run build:plugins && mise run verify && git add packages/plugin && git commit -m "feat(plugin): the host renders evidence through the plugin that owns its kind

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The audit reads text or binary from the kinds

**Files:**
- Modify: `packages/audit/src/evidence.ts` (`integrity`), `packages/audit/src/index.ts` (`FullInput.isText?`), `packages/cli/src/commands.ts` (`fullReport` passes `isText(host kinds)`)
- Test: `packages/audit/test/evidence.test.ts`

**Interfaces:**
- `integrity(root, entries, scenarios, hasCommit, opts?: { commitBinary?: boolean; isText?: (kind: string) => boolean })`. The default `isText` is `isText({})`, meaning the first-party table plus aliases. A medium needs its file unless it is binary and binary is not committed.
- The `FullInput` gains `isText?`. The CLI builds it from `h.evidence.kinds()` mapped to `KindDecl`s.

- [ ] **Step 1: Write the failing test:**
  - a missing `evidence-x/notes` file is a problem when `isText` says text, and not when binary;
  - the old `image` kind stays binary, through its alias.
- [ ] **Step 2: Run it and watch it fail.** Then implement: replace the `BINARY` set with `isText`.
- [ ] **Step 3: Run it and watch it pass**: the audit tests, the CLI tests, and `mise run -q zarg -- audit --summary` (integrity 0).
- [ ] **Step 4: Commit**

```bash
mise run verify && git add packages/audit packages/cli && git commit -m "feat(audit): text or binary media from the declared evidence kinds

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The catalog renders through plugins, sanitized, with a fallback card

**Files:**
- Create: `packages/catalog/src/sanitize.ts`, `packages/catalog/test/sanitize.test.ts`
- Modify:
  - `packages/catalog/src/model.ts`: `MediaView` gains `kind` (the resolved ref), `label`, and `files: { name, url, text? }[]` (all of a medium's files, with the URL relative to the site root);
  - `packages/catalog/src/pages.ts`: media come from `rendered`, with no built-in formats;
  - `packages/catalog/src/build.ts`: copies the assets the pages use;
  - `packages/catalog/src/index.ts`;
  - `packages/cli/src/commands.ts` (`catalogBuild`).
- Test: `packages/catalog/test/{pages,build}.test.ts` (rewritten media expectations)

**Interfaces:**
- Produces:
```ts
// sanitize.ts
/** Plugin-rendered HTML with nothing that runs or reaches out: an allowlist of tags and attributes (HTMLRewriter). */
export const sanitize: (html: string) => Promise<string>
// model / pages
export type Fragment = { readonly html: string; readonly assets: ReadonlyArray<{ readonly owner: string; readonly name: string; readonly path: string }> } | { readonly fallback: string }
/** media path → its fragment, rendered and sanitized before pages() runs. */
export type Rendered = ReadonlyMap<string, Fragment>
export const pages: (c: Catalog, rendered: Rendered) => ReadonlyMap<string, string>
export const build: (input: { catalog: Catalog; rendered: Rendered; root: string; out: string }) => void
/** Renders every present medium through `render` (the host's) and sanitizes it; anything not ok becomes a fallback. */
export const renderAll: (c: Catalog, render: (m: MediaView) => Promise<RenderedLike>) => Promise<Rendered>
```
- **The allowlist** (anything else is unwrapped, keeping its text; the blocked elements in Global Constraints are removed with their content):
  - **tags:** `div span p pre code figure figcaption img video source picture details summary a ul ol li table thead tbody tr td th h3 h4 h5 strong em b i u s small br hr time kbd samp abbr mark sup sub svg g rect circle line polyline polygon path text tspan title desc defs clipPath`;
  - **attributes:**
    - `class title alt width height loading decoding controls loop muted playsinline preload poster type open colspan rowspan datetime role lang dir`;
    - `aria-*`, `data-*`;
    - SVG presentation: `viewBox xmlns x y x1 y1 x2 y2 cx cy r rx ry dx dy points d fill fill-opacity stroke stroke-width opacity font-family font-size font-weight font-style text-decoration text-anchor dominant-baseline xml:space transform preserveAspectRatio`;
    - `href` and `src` only when relative (no scheme, no `//`), `#…`, or `data:image/(png|gif|jpeg|webp);base64,`.
  - **Checking schemes:** lowercase and strip whitespace and control characters first.
- **The fallback card:** `<figure class="medium fallback"><p>{label or kind}: {caption}</p><p class="absent">{reason}</p><ul>{file links}</ul></figure>`.
- **Assets on a page:** the assets of every fragment on it, deduplicated and sorted:
  - each `.css` as `<link rel="stylesheet" href="{up}plugins/<owner>/<name>">`;
  - each `.js` as `<script src="{up}plugins/<owner>/<name>"></script>`, at the end of `body`.
- **The build** copies each used asset to `out/plugins/<owner>/<name>`.
- **The asciinema player and the catalog's own media formats are removed from `@zarg/catalog`.** Plan B's `evidence-terminal` ships the player.

- [ ] **Step 1: Write the failing tests.**
  - **`sanitize.test.ts`:**

```ts
import { expect, test } from "bun:test"
import { sanitize } from "../src/sanitize"

test("nothing that runs or reaches out survives", async () => {
  const cases: Array<[string, string]> = [
    ["<p>ok <b>bold</b></p>", "<p>ok <b>bold</b></p>"],
    ["<scr<script>ipt>alert(1)</script>", "&lt;scr"],
    ["<svg><script>alert(1)</script><text x=\"1\">t</text></svg>", "<svg><text x=\"1\">t</text></svg>"],
    ["<a href=\" JaVaScRiPt:alert(1)\">x</a>", "<a>x</a>"],
    ["<img src=x onerror=alert(1)>", "<img src=\"x\">"],
    ["<svg><use href=\"http://evil/x.svg#a\"/></svg>", "<svg></svg>"],
    ["<img src=\"data:image/png;base64,iVBOR\">", "<img src=\"data:image/png;base64,iVBOR\">"],
    ["<img src=\"data:text/html,<script>\">", "<img>"],
    ["<div style=\"background:url(http://evil)\" data-cast=\"a.cast\">x</div>", "<div data-cast=\"a.cast\">x</div>"],
    ["<iframe src=\"a.html\">x</iframe><form><input></form>", ""],
  ]
  for (const [html, want] of cases) {
    const got = await sanitize(html)
    expect(got.toLowerCase()).not.toMatch(/<script|onerror|javascript:|<iframe|<form|<input|http:\/\/evil|style=/)
    if (want !== "&lt;scr") expect(got).toBe(want)
  }
})
```
  - **`pages.test.ts` and `build.test.ts`:** replace the media expectations with these.
    - The fixture's `rendered` gives S-1's buffer the fragment `{ html: '<pre class="t">plans</pre>', assets: [{ owner: "evidence-terminal", name: "terminal.css", path: <a temp file> }] }` and its cast a fallback (`rendered by evidence-terminal, not installed`).
    - S-1's page contains `<pre class="t">plans</pre>` and `href="../plugins/evidence-terminal/terminal.css"`.
    - It contains the fallback card's reason, with links to `../media/S-1/step.cast`.
    - The build writes `plugins/evidence-terminal/terminal.css`.
    - Two builds still give the same bytes.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement `sanitize.ts`** with `HTMLRewriter`:
  - `element()` checks the tag against the blocked set (`remove()`), then the allowlist (`removeAndKeepContent()` when not on it);
  - for each attribute, keep it only if it is allowed and its URL value passes;
  - text is passed through (HTMLRewriter already re-escapes it).

  Then implement `renderAll`, and the `pages` and `build` changes. In the CLI's `catalog build`:
  1. build the catalog;
  2. run `await renderAll(catalog, (m) => Effect.runPromise(host.evidence.render({ kind: m.kind, caption: m.caption, meta: m.meta, files: m.files })))`, inside the Effect with the `PluginHost` provided;
  3. map an `ok: false` result to `{ fallback: reason }`;
  4. call `build`.
- [ ] **Step 4: Run them and watch them pass**: the catalog tests, the CLI tests, and `tsc`. A manual check: `mise run -q zarg -- catalog build --out /tmp/claude-…/scratchpad/site` in this repo. Every J-0005 medium shows as a fallback card naming `evidence-terminal`, until plan B.
- [ ] **Step 5: Commit**

```bash
mise run build:plugins && mise run verify && git add packages/catalog packages/cli bun.lock && git commit -m "feat(catalog): evidence renders through its plugin, sanitized; a fallback card for any kind it cannot render

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage for plan A:**
  - the contract (kinds, aliases, text or binary, `Capture`, builders, writer, `Step.attach`): Tasks 1 and 2;
  - plugins declaring kinds and assets, and the scope: Task 3;
  - the host's `renderEvidence`, never failing the build: Task 4;
  - the audit reading text or binary from the kinds: Task 5;
  - the sanitizer, asset copying, the fallback card, and the catalog knowing no formats: Task 6.
- **Deferred to plan B:**
  - `evidence-terminal` and `evidence-screen` with their renderers and assets (the player moves there);
  - `@zarg/evidence-capture-xterm` and `-playwright`;
  - J-0002's visual steps, and J-0005 recaptured through the xterm adapter.
- **Deferred to plan C:** the catalog for any project, and the UX.
- **An intermediate state is accepted:** between plans A and B, the catalog shows fallback cards for every medium. Plan B follows straight on.
- **Types:**
  - `Capture` and `Media` come from Task 1 and are used in Tasks 2 and 6;
  - `KindDecl` is used in Tasks 3 and 5;
  - `RenderInput`/`Rendered` (Task 4) are consumed by `renderAll` (Task 6) through a structural `RenderedLike`.
