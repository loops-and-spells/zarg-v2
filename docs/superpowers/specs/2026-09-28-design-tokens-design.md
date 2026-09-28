# Design tokens

Date: 2026-09-28
Status: design approved in conversation (plugins get intent, identity and severity only; web palette defined now), pending written review
Touches: new `@zarg/tokens`; `@zarg/view` (`THEME`, tones, the Tone schema), `@zarg/view-tui` (every colour it draws), `@zarg/markdown` / the TUI's highlight map, `@zarg/agent-rehearse` and `@zarg/plugin-gherkin` (tone names in their views)

## Outcome

zarg's design language is one package every platform and plugin uses: the same token keys everywhere, each platform giving its own values. A colour means the same thing on every screen: a card id is always the card colour, a persona always the persona colour, "high" always the high-severity colour. The terminal gets palettes for what it can show (truecolor, 256, 16 colours); the web gets its own (light and dark).

## Keys

Keys are semantic names, grouped by role. The same set on every platform.

| Group | Keys | Who may name them |
|---|---|---|
| Surfaces | `ground`, `raised`, `shade`, `line`, `selection` | the shell |
| Text | `text`, `dim`, `faint` | the shell; plugins through `dim` (below) |
| Intent | `accent`, `attention`, `ok`, `error` | shell and plugins |
| Identity | `card`, `state`, `persona`, `journey`, `agent`, `zarg` | shell and plugins |
| Severity | `severity.high`, `severity.medium`, `severity.low` | shell and plugins |
| Status | `running`, `asks`, `done`, `failed` | the shell |
| Syntax | `keyword`, `comment`, `string`, `number` | the shell (the highlighter) |

- **Plugins name intent, identity and severity keys only** (and `dim` for de-emphasis): they say what a thing is; the shell decides how surfaces, text and status look. A plugin naming another key is refused at build and load (as surfaces are).
- The old tones stay valid as aliases, so existing plugins keep working: `normal → text`, `ok → ok`, `warn → attention`, `error → error`, `dim → dim`, `accent → accent`.

## Two layers: Theme over Palette

- **Palette** (per platform): named colours and their values on one platform: `ink`, `slate.950`, `slate.900`, `slate.850`, `slate.800`, `slate.700`, `gray.500`, `gray.600`, `gray.400`, `blue`, `amber`, `green`, `red`. The names are the same on every platform; the values are the platform's: a hex for truecolor, the nearest index for ansi256, an ANSI colour (and a weight, where colours run out) for ansi16, a CSS value for the web.
- **Theme** (one, platform-free): token keys to palette colour names. Base keys name a colour (`ground → slate.950`, `accent → blue`, `attention → amber`, `ok → green`, `error → red`, `dim → gray.500` …); identity, severity, status and syntax keys alias base keys (`card → attention`, `journey → ok`, `persona → accent`, `severity.high → error`, `keyword → accent` …). So a colour is aliased once and means the same on every platform; a platform only says what `amber` looks like there.

```ts
// @zarg/tokens
export const BASE = { ground: "slate.950", raised: "slate.900", shade: "slate.850", selection: "slate.800", line: "slate.700",
  text: "ink", dim: "gray.500", faint: "gray.600", accent: "blue", attention: "amber", ok: "green", error: "red" } as const
export const ALIASES = { card: "attention", state: "text", persona: "accent", journey: "ok", agent: "text", zarg: "accent",
  "severity.high": "error", "severity.medium": "attention", "severity.low": "dim",
  running: "accent", asks: "attention", done: "dim", failed: "error",
  keyword: "accent", comment: "dim", string: "ok", number: "attention" } as const
```

## Palettes

- `terminal.truecolor`: today's hex values (`THEME`), unchanged: `slate.950 #0f1115`, `slate.900 #161a21`, `slate.850 #1a1f28`, `slate.800 #1f2533`, `slate.700 #262b35`, `ink #d7dce2`, `gray.500 #6b7280`, `gray.600 #3b4150`, `blue #7aa2f7`, `amber #e0af68`, `green #9ece6a`, `red #f7768e`.
- `terminal.ansi256`: the nearest of the 256 colours to each truecolor value.
- `terminal.ansi16`: the 16 ANSI colours, by colour alone (the terminal draws `fg` only): the slates collapse to black, the cursor row (`slate.800`) is navy so grey text stays readable on it, and hues are the bright ones (cyan for blue, yellow for amber, lime for green) so they read on black. `[theme] colors` in config.toml is not read yet: `ZARG_THEME_COLORS` sets it.
- `web.dark` (the truecolor hexes as CSS values) and `web.light` (a light ground, the same hues darkened for contrast: WCAG AA for text on `ground`).

Each colour's value is `{ fg: string, bold?: true, faint?: true }`. Types make every palette give every colour name; a test checks every key resolves to a colour on every palette.

## The services (Effect)

```ts
// @zarg/tokens
export class Palette extends Context.Service<Palette, {
  readonly platform: Platform  // "terminal.truecolor" | "terminal.ansi256" | "terminal.ansi16" | "web.dark" | "web.light"
  /** A colour name's value on this platform. */
  readonly color: (name: ColorName) => ColorValue  // { fg, bold?, faint? }
}>()("@zarg/tokens/Palette") {
  /** One platform's palette (tests, the web, a config setting). */
  static readonly of: (platform: Platform) => Layer.Layer<Palette>
  /** The terminal's palette: `[theme] colors` in the config, else COLORTERM / TERM (read through Effect's Config). */
  static readonly terminal: Layer.Layer<Palette, ConfigError>
}
export class Theme extends Context.Service<Theme, {
  /** The palette it draws with. */
  readonly palette: Palette["Service"]
  /** A key's value (aliases resolved to a base key, the base key to a colour name, the name to the palette's value). */
  readonly value: (key: TokenKey) => ColorValue
  /** A plugin's tone (a plugin key or an old tone name) as a key; unknown or not allowed: `text`. */
  readonly tone: (tone: unknown) => TokenKey
}>()("@zarg/tokens/Theme") {
  /** zarg's theme over whatever Palette is provided. */
  static readonly layer: Layer.Layer<Theme, never, Palette>
}
```

- Providing a theme: `Theme.layer` over `Palette.terminal` (the TUI), `Palette.of("web.dark")` (the web), `Palette.of("terminal.truecolor")` (tests).
- Choosing a terminal palette (`Palette.terminal`): `[theme] colors = "truecolor" | "256" | "16"` wins; else `COLORTERM=truecolor|24bit` → truecolor, `TERM` containing `256color` → ansi256, else ansi16. Inputs come through Effect `Config`, so tests provide them (`ConfigProvider.fromMap`) instead of touching the environment.
- The TUI's entry (`runTui`) yields `Theme` once and hands it to the React tree (a `ThemeContext` at the app root; components read it with `useTheme()`). React components never reach the environment or Effect themselves.
- Everything else that colours (the Markdown highlight map, a future web renderer, a CLI printing colour) yields `Theme` or reads it from the context it was given.

## Consumers

- `@zarg/view`: the `Tone` schema accepts the plugin keys (intent, identity, severity, `dim`) and the old tones; `THEME`, `toneToken` and `toneColor` go (their callers move to `Theme`).
- `@zarg/view-tui`: every colour from `useTheme().value(key)` (weight attributes where the palette asks); `App` takes the Theme as a prop from `runTui`, and tests render with the truecolor palette (or ansi16).
- The TUI's highlight map comes from the syntax and identity keys (`id → card`, `persona`, `journey`).
- Rehearse and Gherkin views: `tone: "card"`, `tone: "journey"`, `tones: { high: "severity.high", medium: "severity.medium", low: "severity.low" }`.

## Errors

- A plugin naming a key outside intent, identity, severity and `dim` (a surface, `text`, a status): refused at build and load with the keys it may use.
- An unknown key: refused the same way.
- A palette missing a colour name: a type error, and the parity test fails.

## Testing

- Tokens: every alias resolves to a base key; every platform has every base key; ansi256 values are the nearest to truecolor (a sample checked by hand); ansi16 marks surfaces by weight.
- View: tone names and token keys resolve to the same colours; the plugin-key check refuses surfaces and statuses.
- Services: `Palette.terminal` under each `COLORTERM` / `TERM` / config combination (a `ConfigProvider` map, never the real environment); `Palette.of` for each platform; `Theme.layer` resolves every key to a colour on every palette; `tone` maps old tones and refuses keys plugins may not name.
- TUI: `App` rendered with the ansi16 palette still tells the cursor row and ticked rows apart.
- Rehearse and Gherkin: their views use identity and severity keys and pass the check.

## Scope

In: the package with the `Palette` and `Theme` services and their Layers, the palettes (terminal truecolor, 256, 16; web dark, light), aliases, the palette choice, `@zarg/view` and the TUI reading from it, the plugin-key check, rehearse's and gherkin's views on identity keys.

Out: user themes, a web renderer (the web palette is data only until one exists), per-plugin colour overrides.
