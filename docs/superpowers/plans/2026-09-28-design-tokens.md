# Design Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One design language every platform uses: `@zarg/tokens` with a platform-free `Theme` (token keys → colour names) over a per-platform `Palette` (colour names → values), provided through Effect; the TUI and plugins colour by token keys.

**Architecture:** `@zarg/tokens` holds the colour names, the base keys and aliases, the palettes, and two Effect services: `Palette` (Layers `Palette.of(platform)`, `Palette.terminal` from Config) and `Theme` (`Theme.layer`, requires `Palette`). `@zarg/view` keeps no colours: its `Tone` schema accepts the plugin keys and the old tones, and `tonesProblem` refuses others at build and load. The TUI receives a Theme from `runTui` (default: truecolor) and reads colours through `useTheme()`.

**Tech Stack:** bun, TypeScript, Effect 4 (`Context.Service`, `Layer`, `Config`, `ConfigProvider`), React 19 / OpenTUI.

**Spec:** `docs/superpowers/specs/2026-09-28-design-tokens-design.md`

## Global Constraints

- Keys (same on every platform): surfaces `ground raised shade line selection`; text `text dim faint`; intent `accent attention ok error`; identity `card state persona journey agent zarg`; severity `severity.high severity.medium severity.low`; status `running asks done failed`; syntax `keyword comment string number`.
- Plugins may name only intent, identity, severity keys and `dim`, plus the old tones `normal ok warn error dim accent` (aliases: `normal→text`, `warn→attention`, the rest to themselves).
- Colour names: `ink slate.950 slate.900 slate.850 slate.800 slate.700 gray.400 gray.500 gray.600 blue amber green red`.
- Truecolor values unchanged from today's `THEME`: `slate.950 #0f1115`, `slate.900 #161a21`, `slate.850 #1a1f28`, `slate.800 #1f2533`, `slate.700 #262b35`, `ink #d7dce2`, `gray.500 #6b7280`, `gray.600 #3b4150`, `gray.400 #8a93a3`, `blue #7aa2f7`, `amber #e0af68`, `green #9ece6a`, `red #f7768e`.
- Tests never read the real environment for the palette choice (`ConfigProvider.fromMap`).
- `mise run verify` passes before every commit; `mise run build:plugins` after changing a first-party plugin.

## Review Focus

1. A terminal with neither `COLORTERM` nor a `256color` `TERM` (a plain `xterm`, `screen`): the 16-colour palette, never a crash or truecolor escapes it cannot show. → Task 1, test "no COLORTERM, a plain TERM: ansi16".
2. A plugin view naming a surface key (`tone: "ground"`) or a status key (`running`) in a column or a row: refused at build and at load, naming the keys it may use. → Task 2, test "tonesProblem refuses shell keys".
3. A row pushed at run time with a tone outside the plugin keys: refused by the data schema (the view keeps its last data), never drawn in an arbitrary colour. → Task 2, test "a row with a shell key tone is refused".
4. The 16-colour palette: the cursor row (`selection`) and the ground differ, so the highlighted row still shows. → Task 1, test "ansi16: selection differs from ground".
5. `[theme] colors = "16"` in config wins over `COLORTERM=truecolor`. → Task 1, test "config wins".

---

### Task 1: `@zarg/tokens`: names, keys, palettes, Palette and Theme

**Files:**
- Create: `packages/tokens/package.json`, `packages/tokens/mise.toml`, `packages/tokens/tsconfig.json` (copy `packages/bm25`'s), `packages/tokens/src/index.ts`, `packages/tokens/test/tokens.test.ts`
- Modify: `AGENTS.md` (the package line)

**Interfaces:**
- Produces: `ColorName`, `TokenKey`, `PluginKey`, `Platform = "terminal.truecolor" | "terminal.ansi256" | "terminal.ansi16" | "web.dark" | "web.light"`, `ColorValue = { fg: string; bold?: true; faint?: true }`, `BASE`, `ALIASES`, `PLUGIN_KEYS: ReadonlySet<string>`, `OLD_TONES: Record<string, TokenKey>`, `PALETTES: Record<Platform, Record<ColorName, ColorValue>>`, `class Palette` (`platform`, `color(name)`; `Palette.of(platform)`, `Palette.terminal`), `class Theme` (`palette`, `value(key)`, `tone(tone)`; `Theme.layer`), `makeTheme(palette): Theme["Service"]` (for non-Effect callers and tests).

- [ ] **Step 1: Write the failing tests** (`packages/tokens/test/tokens.test.ts`)

```ts
import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { ALIASES, BASE, makeTheme, Palette, PALETTES, type Platform, Theme } from "../src"

const platforms = Object.keys(PALETTES) as ReadonlyArray<Platform>
const keys = [...Object.keys(BASE), ...Object.keys(ALIASES)]
const themeOn = (p: Platform) => Effect.runSync(Effect.provide(Theme.asEffect(), Theme.layer.pipe(Layer.provide(Palette.of(p)))))
const choose = (env: Record<string, string>) =>
  Effect.runSync(Effect.map(Palette.asEffect(), (p) => p.platform).pipe(Effect.provide(Palette.terminal), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))))

describe("tokens", () => {
  test("every key resolves to a colour on every palette; every palette names every colour", () => {
    for (const p of platforms) {
      const th = themeOn(p)
      for (const k of keys) expect(th.value(k as never).fg).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
  test("truecolor keeps today's values; aliases follow their base key", () => {
    const th = themeOn("terminal.truecolor")
    expect(th.value("ground").fg).toBe("#0f1115")
    expect(th.value("card").fg).toBe(th.value("attention").fg)
    expect(th.value("severity.high").fg).toBe("#f7768e")
    expect(th.value("journey").fg).toBe("#9ece6a")
  })
  test("ansi256 is the nearest xterm colour; ansi16: selection differs from ground", () => {
    expect(themeOn("terminal.ansi256").value("accent").fg).toBe("#87afff")
    const t16 = themeOn("terminal.ansi16")
    expect(t16.value("selection").fg).not.toBe(t16.value("ground").fg)
  })
  test("plugin tones: plugin keys and old tones map; shell keys and unknowns fall to text", () => {
    const th = makeTheme(PALETTES["terminal.truecolor"], "terminal.truecolor")
    expect(th.tone("warn")).toBe("attention")
    expect(th.tone("severity.high")).toBe("severity.high")
    expect(th.tone("ground")).toBe("text")
    expect(th.tone("nope")).toBe("text")
  })
})

describe("choosing a terminal palette", () => {
  test("COLORTERM truecolor or 24bit: truecolor", () => {
    expect(choose({ COLORTERM: "truecolor", TERM: "xterm" })).toBe("terminal.truecolor")
    expect(choose({ COLORTERM: "24bit" })).toBe("terminal.truecolor")
  })
  test("a 256color TERM: ansi256", () => expect(choose({ TERM: "xterm-256color" })).toBe("terminal.ansi256"))
  test("no COLORTERM, a plain TERM: ansi16", () => {
    expect(choose({ TERM: "xterm" })).toBe("terminal.ansi16")
    expect(choose({})).toBe("terminal.ansi16")
  })
  test("config wins", () => expect(choose({ ZARG_THEME_COLORS: "16", COLORTERM: "truecolor" })).toBe("terminal.ansi16"))
})
```

(`ZARG_THEME_COLORS` is how the config's `[theme] colors` reaches `Config`; the CLI passes it from zarg's config when it builds the layer.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/tokens && mise x -- bun test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`packages/tokens/src/index.ts`)

```ts
import { Config, Context, Effect, Layer } from "effect"

export type ColorName = "ink" | "slate.950" | "slate.900" | "slate.850" | "slate.800" | "slate.700" | "gray.400" | "gray.500" | "gray.600" | "blue" | "amber" | "green" | "red"
export interface ColorValue { readonly fg: string; readonly bold?: true; readonly faint?: true }
export type Platform = "terminal.truecolor" | "terminal.ansi256" | "terminal.ansi16" | "web.dark" | "web.light"

/** Base keys name a colour; the rest alias a base key. */
export const BASE = { ground: "slate.950", raised: "slate.900", shade: "slate.850", selection: "slate.800", line: "slate.700", text: "ink", dim: "gray.500", faint: "gray.600", accent: "blue", attention: "amber", ok: "green", error: "red" } as const satisfies Record<string, ColorName>
export const ALIASES = { card: "attention", state: "text", persona: "accent", journey: "ok", agent: "text", zarg: "accent", "severity.high": "error", "severity.medium": "attention", "severity.low": "dim", running: "accent", asks: "attention", done: "dim", failed: "error", keyword: "accent", comment: "dim", string: "ok", number: "attention" } as const satisfies Record<string, keyof typeof BASE>
export type BaseKey = keyof typeof BASE
export type TokenKey = BaseKey | keyof typeof ALIASES
/** What a plugin may name: intent, identity, severity, and dim. */
export const PLUGIN_KEYS: ReadonlySet<string> = new Set(["accent", "attention", "ok", "error", "dim", "card", "state", "persona", "journey", "agent", "zarg", "severity.high", "severity.medium", "severity.low"])
/** The tones plugins named before tokens. */
export const OLD_TONES: Readonly<Record<string, TokenKey>> = { normal: "text", ok: "ok", warn: "attention", error: "error", dim: "dim", accent: "accent" }

const TRUECOLOR: Record<ColorName, string> = { ink: "#d7dce2", "slate.950": "#0f1115", "slate.900": "#161a21", "slate.850": "#1a1f28", "slate.800": "#1f2533", "slate.700": "#262b35", "gray.400": "#8a93a3", "gray.500": "#6b7280", "gray.600": "#3b4150", blue: "#7aa2f7", amber: "#e0af68", green: "#9ece6a", red: "#f7768e" }
// xterm's 256 colours: 16 system, a 6×6×6 cube, 24 greys.
const XTERM: ReadonlyArray<string> = (() => {
  const sys = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]
  const lv = [0, 95, 135, 175, 215, 255]
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
  const cube = lv.flatMap((r) => lv.flatMap((g) => lv.map((b) => hex(r, g, b))))
  const greys = Array.from({ length: 24 }, (_, i) => hex(8 + i * 10, 8 + i * 10, 8 + i * 10))
  return [...sys, ...cube, ...greys]
})()
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
/** The nearest of the colours given (squared RGB distance). */
const nearest = (h: string, among: ReadonlyArray<string>) => {
  const [r, g, b] = rgb(h)
  return among.reduce((best, c) => { const [x, y, z] = rgb(c); const d = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2; return d < best.d ? { c, d } : best }, { c: among[0]!, d: Infinity }).c
}
const map = (f: (n: ColorName, h: string) => ColorValue) => Object.fromEntries(Object.entries(TRUECOLOR).map(([n, h]) => [n, f(n as ColorName, h)])) as Record<ColorName, ColorValue>
export const PALETTES: Record<Platform, Record<ColorName, ColorValue>> = {
  "terminal.truecolor": map((_, h) => ({ fg: h })),
  "terminal.ansi256": map((_, h) => ({ fg: nearest(h, XTERM.slice(16)) })),
  // 16 colours: the slates collapse to black and bright black; weight tells them apart where it must.
  "terminal.ansi16": {
    ink: { fg: "#c0c0c0" }, "slate.950": { fg: "#000000" }, "slate.900": { fg: "#000000" }, "slate.850": { fg: "#000000" }, "slate.800": { fg: "#808080" }, "slate.700": { fg: "#808080" },
    "gray.400": { fg: "#c0c0c0" }, "gray.500": { fg: "#808080" }, "gray.600": { fg: "#808080", faint: true },
    blue: { fg: "#0000ff", bold: true }, amber: { fg: "#808000", bold: true }, green: { fg: "#008000" }, red: { fg: "#ff0000" },
  },
  "web.dark": map((_, h) => ({ fg: h })),
  "web.light": {
    ink: { fg: "#1f2328" }, "slate.950": { fg: "#ffffff" }, "slate.900": { fg: "#f6f8fa" }, "slate.850": { fg: "#eef1f5" }, "slate.800": { fg: "#e3e8ef" }, "slate.700": { fg: "#d0d7de" },
    "gray.400": { fg: "#59636e" }, "gray.500": { fg: "#656d76" }, "gray.600": { fg: "#8c959f" },
    blue: { fg: "#0969da" }, amber: { fg: "#9a6700" }, green: { fg: "#1a7f37" }, red: { fg: "#cf222e" },
  },
}

export class Palette extends Context.Service<Palette, { readonly platform: Platform; readonly color: (name: ColorName) => ColorValue }>()("@zarg/tokens/Palette") {
  static readonly of = (platform: Platform) => Layer.succeed(Palette, Palette.of_(platform))
  static readonly of_ = (platform: Platform) => ({ platform, color: (name: ColorName) => PALETTES[platform][name] })
  /** The terminal's: ZARG_THEME_COLORS (the config's `[theme] colors`), else COLORTERM, else TERM. */
  static readonly terminal = Layer.effect(
    Palette,
    Effect.gen(function* () {
      const set = yield* Config.string("ZARG_THEME_COLORS").pipe(Config.withDefault(""))
      const colorterm = yield* Config.string("COLORTERM").pipe(Config.withDefault(""))
      const term = yield* Config.string("TERM").pipe(Config.withDefault(""))
      const platform: Platform =
        set === "truecolor" ? "terminal.truecolor" : set === "256" ? "terminal.ansi256" : set === "16" ? "terminal.ansi16"
        : /^(truecolor|24bit)$/i.test(colorterm) ? "terminal.truecolor" : /256color/.test(term) ? "terminal.ansi256" : "terminal.ansi16"
      return Palette.of_(platform)
    }),
  )
}

/** zarg's theme over a palette: a key, its alias's base key, the base key's colour, the palette's value. */
export const makeTheme = (colors: Record<ColorName, ColorValue>, platform: Platform) => {
  const base = (key: TokenKey): BaseKey => (key in ALIASES ? ALIASES[key as keyof typeof ALIASES] : (key as BaseKey))
  return {
    palette: { platform, color: (n: ColorName) => colors[n] },
    value: (key: TokenKey): ColorValue => colors[BASE[base(key)]],
    tone: (tone: unknown): TokenKey => (typeof tone !== "string" ? "text" : PLUGIN_KEYS.has(tone) ? (tone as TokenKey) : (OLD_TONES[tone] ?? "text")),
  }
}
export class Theme extends Context.Service<Theme, ReturnType<typeof makeTheme>>()("@zarg/tokens/Theme") {
  static readonly layer = Layer.effect(Theme, Effect.map(Palette.asEffect(), (p) => makeTheme(PALETTES[p.platform], p.platform)))
}
```

(Check the exact Effect 4 names for `Context.Service`, `Palette.asEffect()`, `ConfigProvider.fromUnknown` / `ConfigProvider.layer` against `packages/model/src` and `packages/plugin-sdk/src/services.ts`, which already use services and config; adjust the test's `choose` helper the same way.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/tokens && mise x -- bun test && cd .. && mise x -- bunx tsc -p tokens --noEmit`
Expected: PASS; if the ansi256 expectation (`#87afff` for `#7aa2f7`) differs, compute the nearest by hand from the formula and correct the expectation (it is an oracle checked by hand, not by the code).

- [ ] **Step 5: Commit**

```bash
git add packages/tokens AGENTS.md bun.lock
git commit -m "feat(tokens): @zarg/tokens: colour names, keys and aliases, palettes per platform, Palette and Theme services"
```

### Task 2: `@zarg/view` names tokens; plugins may name only theirs

**Files:**
- Modify: `packages/view/src/schema.ts` (`Tone`), `packages/view/src/theme.ts` (removed), `packages/view/src/index.ts`, `packages/view/src/surfaces.ts` (add `tonesProblem`), `packages/view/package.json` (depend on `@zarg/tokens`)
- Modify: `packages/plugin-sdk/src/define.ts` and `packages/plugin/src/server/host.ts:117` (call `tonesProblem` beside `surfacesProblem`)
- Test: `packages/view/test/theme.test.ts` (replace), `packages/view/test/surfaces.test.ts`

**Interfaces:**
- Consumes: `PLUGIN_KEYS`, `OLD_TONES` (Task 1).
- Produces: `Tone` schema = literals of `PLUGIN_KEYS` ∪ `OLD_TONES` keys; `tonesProblem(layouts: ReadonlyArray<Layout>): string | undefined`. `THEME`, `toneToken`, `toneColor`, `ThemeToken` no longer exported.

- [ ] **Step 1: Write the failing tests**

`packages/view/test/theme.test.ts` (replace its content):

```ts
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { defineView, layoutOf, TableData, tonesProblem, Tone } from "../src"

test("a tone is a plugin key or an old tone name", () => {
  for (const t of ["warn", "normal", "card", "journey", "severity.high", "dim"]) expect(Schema.decodeUnknownExit(Tone)(t)._tag).toBe("Success")
  for (const t of ["ground", "running", "keyword", "nope"]) expect(Schema.decodeUnknownExit(Tone)(t)._tag).toBe("Failure")
})
test("tonesProblem refuses shell keys in a view's columns", () => {
  const ok = layoutOf(defineView("t", { list: { kind: "table", role: "primary", columns: [{ id: "c", label: "c", tone: "card", tones: { high: "severity.high" } }] } }))
  expect(tonesProblem([ok])).toBeUndefined()
  const bad = { ...ok, sections: [{ ...ok.sections[0]!, columns: [{ id: "c", label: "c", tone: "ground" }] }] } as never
  expect(tonesProblem([bad])).toMatch(/ground.*may name/)
})
test("a row with a shell key tone is refused", () => {
  expect(Schema.decodeUnknownExit(TableData)({ rows: [{ id: "a", cells: {}, tone: "running" }] })._tag).toBe("Failure")
})
```

(Adjust the `defineView` column literal typing if `tone: "card"` needs `as const`; the LeafSpec column type from the earlier task already allows a tone name.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/view && mise x -- bun test test/theme.test.ts`
Expected: FAIL (`tonesProblem` not exported; `card` not a tone).

- [ ] **Step 3: Implement**

- `schema.ts`: `export const Tone = Schema.Literals([...PLUGIN_KEYS, ...Object.keys(OLD_TONES)] as [string, ...string[]])` (dedupe `ok`, `error`, `dim`, `accent`), importing from `@zarg/tokens`.
- `surfaces.ts`: `tonesProblem` walks every table column (`tone`, `tones` values) of every layout (tabs included) and returns ``view ${name}: column ${id} names ${tone}; plugins may name ${[...PLUGIN_KEYS].join(", ")} (or normal, ok, warn, error, dim, accent)`` for the first key that `Schema.is(Tone)` rejects.
- `define.ts` (build) and `host.ts` (load): after the surfaces check, `const tones = tonesProblem(views); if (tones !== undefined) throw/return tones` the same way.
- Delete `theme.ts`; drop its export from `index.ts`. Callers are migrated in Task 3 (view-tui) and Task 4 (markdown); until then `mise x -- bunx tsc` in those packages fails, so Tasks 2-4 commit together at the end of Task 4 (a ruling-free way: stage Task 2's files now, commit with Task 4).

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/view && mise x -- bun test`
Expected: PASS.

- [ ] **Step 5: (no commit yet: see Step 3)**

### Task 3: The TUI draws with a Theme

**Files:**
- Create: `packages/view-tui/src/theme.tsx` (`ThemeContext`, `useTheme()`, `useColors()`)
- Modify: `packages/view-tui/src/app.tsx`, `packages/view-tui/src/sections.tsx`, `packages/view-tui/src/markdown.tsx`, `packages/view-tui/package.json` (depend on `@zarg/tokens`), `packages/cli/src/tui/run.tsx`
- Test: `packages/view-tui/test/app.test.tsx`, `packages/view-tui/test/sections.test.tsx` (their `THEME` imports), a new ansi16 test

**Interfaces:**
- Consumes: `makeTheme`, `PALETTES`, `Theme`, `Palette` (Task 1); `Tone` (Task 2).
- Produces: `App` prop `theme?: Theme["Service"]` (default: truecolor); `useTheme(): Theme["Service"]`; `useColors()`: an object with today's `THEME` field names (`bg raised line text dim faint accent attention ok error selection shade`) read from the theme, so call sites change from `THEME.x` to `C.x` mechanically; `toneFg(theme, tone) = theme.value(theme.tone(tone)).fg`.

- [ ] **Step 1: Write the failing test** (`packages/view-tui/test/app.test.tsx`, a new describe)

```tsx
describe("the theme", () => {
  test("with the 16-colour palette the cursor row still differs from the rows around it", async () => {
    const theme = makeTheme(PALETTES["terminal.ansi16"], "terminal.ansi16")
    const t = await render(viewState, { width: 110, height: 24 }, theme)
    t.mockInput.pressKey("a", { meta: true }); await settle(t); t.mockInput.pressEnter(); await settle(t)
    const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
    const spans = t.captureSpans().lines.flatMap((l) => l.spans)
    const cursor = spans.find((s) => s.text.includes("▍"))!
    expect(hex(cursor.bg)).toBe(theme.value("selection").fg)
    expect(hex(cursor.bg)).not.toBe(theme.value("ground").fg)
  })
})
```

(The test helper `render` gains an optional third argument `theme`, passed to `<App theme={…} />`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/view-tui && mise x -- bun test test/app.test.tsx -t "the theme"`
Expected: FAIL (`App` takes no theme).

- [ ] **Step 3: Implement**

`src/theme.tsx`:

```tsx
import { createContext, useContext } from "react"
import { makeTheme, PALETTES, type Theme } from "@zarg/tokens"

type ThemeService = Theme["Service"]
const DEFAULT = makeTheme(PALETTES["terminal.truecolor"], "terminal.truecolor")
export const ThemeContext = createContext<ThemeService>(DEFAULT)
export const useTheme = () => useContext(ThemeContext)
/** The colours by the names the TUI has always used (a mechanical move from THEME). */
export const colorsOf = (t: ThemeService) => ({
  bg: t.value("ground").fg, raised: t.value("raised").fg, line: t.value("line").fg, text: t.value("text").fg, dim: t.value("dim").fg, faint: t.value("faint").fg,
  accent: t.value("accent").fg, attention: t.value("attention").fg, ok: t.value("ok").fg, error: t.value("error").fg, selection: t.value("selection").fg, shade: t.value("shade").fg,
})
export const useColors = () => colorsOf(useTheme())
/** A plugin's tone as a colour. */
export const toneFg = (t: ThemeService, tone: unknown) => t.value(t.tone(tone)).fg
```

- `app.tsx`: `App` takes `theme?: ThemeService`; wraps its tree in `<ThemeContext.Provider value={props.theme ?? DEFAULT}>`; inside, `const C = useColors()` and every `THEME.x` becomes `C.x`; `toneColor(x)` becomes `toneFg(theme, x)`.
- `sections.tsx`: each component that colours calls `const C = useColors()` (and `useTheme()` for tones); replace `THEME.x` → `C.x`, `fg(t)` → `toneFg(theme, t)`. Module-level helpers that take no props (`Gutter`, `Buttons`, …) become components reading the hook, or take `C` as a prop.
- `markdown.tsx`: the syntax style and the highlight map are built from `useTheme()` inside `RichText` (memoised on the theme): `keyword`, `comment`, `string`, `number` from the syntax keys; `id → card`, `persona`, `journey`, `title → text`, `flow → accent`.
- `cli/src/tui/run.tsx`: build the theme with Effect before rendering: `const theme = await Effect.runPromise(Theme.asEffect().pipe(Effect.provide(Theme.layer), Effect.provide(Palette.terminal), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...process.env, ZARG_THEME_COLORS: <config [theme] colors or undefined> })))))`, and pass `theme={theme}` to `App` (read `[theme] colors` with the config loader `packages/model` already uses; absent: leave `ZARG_THEME_COLORS` unset).
- Tests: `THEME` imports become `colorsOf(makeTheme(PALETTES["terminal.truecolor"], "terminal.truecolor"))` (a `T` constant at the top of each test file).

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/view-tui && mise x -- bun test && cd .. && mise x -- bunx tsc -p view-tui --noEmit && mise x -- bunx tsc -p cli --noEmit`
Expected: PASS (every existing frame test unchanged: truecolor is today's colours).

- [ ] **Step 5: (commit with Task 4)**

### Task 4: Plugins name identity keys

**Files:**
- Modify: `packages/agent-rehearse/src/views.ts`, `packages/plugin-gherkin/src/views.ts` (if it names tones), `packages/markdown/src/index.ts` (its `Highlight` type takes the token names)
- Test: `packages/agent-rehearse/test/run.test.ts` (columns), `packages/plugin-gherkin/test/journeys.test.ts` (build passes `tonesProblem`)

**Interfaces:**
- Consumes: `Tone` (Task 2).

- [ ] **Step 1: Write the failing test** (`packages/agent-rehearse/test/run.test.ts`, next to the columns test)

```ts
test("the findings columns colour by meaning: card, journey, severity keys", () => {
  expect(FINDING_COLUMNS.map((c) => [c.id, "tone" in c ? c.tone : undefined, "tones" in c ? c.tones : undefined])).toEqual([
    ["card", "card", undefined],
    ["journey", "journey", undefined],
    ["kind", undefined, undefined],
    ["severity", undefined, { high: "severity.high", medium: "severity.medium", low: "severity.low" }],
  ])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agent-rehearse && mise x -- bun test test/run.test.ts -t "colour by meaning"`
Expected: FAIL (tones are `warn`, `ok`, `error` …).

- [ ] **Step 3: Implement**

`views.ts`: `{ id: "card", …, tone: "card" }`, `{ id: "journey", …, tone: "journey" }`, `tones: { high: "severity.high", medium: "severity.medium", low: "severity.low" }`. Import `FINDING_COLUMNS` in the test from `../src/views`.

- [ ] **Step 4: Run to verify, then the whole repo**

Run: `mise run build:plugins && mise run verify`
Expected: PASS.

- [ ] **Step 5: Commit (Tasks 2-4 together)**

```bash
git add packages/view packages/view-tui packages/markdown packages/cli/src/tui/run.tsx packages/plugin-sdk/src/define.ts packages/plugin/src/server packages/agent-rehearse packages/plugin-gherkin bun.lock AGENTS.md
git commit -m "feat: the TUI and plugins colour by token keys through the Theme; plugins may name only intent, identity and severity"
```
