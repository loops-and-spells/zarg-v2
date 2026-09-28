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

## Aliases, then values

Identity, severity, status and syntax keys alias base keys; a platform gives values for the base keys only (surfaces, text, intent), so a palette is small and every alias follows it.

```ts
// @zarg/tokens
export const ALIASES = {
  card: "attention", state: "text", persona: "accent", journey: "ok", agent: "text", zarg: "accent",
  "severity.high": "error", "severity.medium": "attention", "severity.low": "dim",
  running: "accent", asks: "attention", done: "dim", failed: "error",
  keyword: "accent", comment: "dim", string: "ok", number: "attention",
} as const
```

A platform may override an alias where its palette needs it (the 16-colour terminal gives `selection` and `shade` the same value and marks the difference with weight instead).

## Platforms

- `terminal.truecolor`: today's hex values (`THEME`), unchanged.
- `terminal.ansi256`: the nearest of the 256 colours to each truecolor value.
- `terminal.ansi16`: the 16 ANSI colours (`black`, `blue`, `bright-black`, …); surfaces that cannot differ by colour differ by weight (`text` bold, `dim` faint attribute).
- `web`: CSS custom properties (`--zarg-card` …), a light and a dark palette; the dark one matches the terminal's truecolor values, the light one is designed for a white ground with the same hues darkened for contrast (WCAG AA for text on `ground`).

Each value is `{ fg: string }` plus, where a platform needs it, `{ bold?: true, faint?: true }`. Types make every platform give every base key; a test checks aliases resolve and every key exists on every platform.

## Choosing a palette (terminal)

`COLORTERM=truecolor|24bit` → truecolor; `TERM` containing `256color` → ansi256; else ansi16. `[theme] colors = "truecolor" | "256" | "16"` in zarg's config overrides. Tests use truecolor.

## Consumers

- `@zarg/view`: `THEME` becomes `palette("terminal.truecolor")` (kept for the TUI's existing uses); `toneToken` / `toneColor` resolve token keys and the old tones through the tokens; the `Tone` schema accepts the plugin keys (intent, identity, severity, `dim`) and the old tones.
- `@zarg/view-tui`: draws with the chosen terminal palette (one `useTokens()` value from the app root; weight attributes where the palette asks).
- The TUI's highlight map comes from the syntax and identity keys (`id → card`, `persona`, `journey`).
- Rehearse and Gherkin views: `tone: "card"`, `tone: "journey"`, `tones: { high: "severity.high", medium: "severity.medium", low: "severity.low" }`.

## Errors

- A plugin naming a key outside intent, identity, severity and `dim` (a surface, `text`, a status): refused at build and load with the keys it may use.
- An unknown key: refused the same way.
- A platform palette missing a base key: a type error, and the parity test fails.

## Testing

- Tokens: every alias resolves to a base key; every platform has every base key; ansi256 values are the nearest to truecolor (a sample checked by hand); ansi16 marks surfaces by weight.
- View: tone names and token keys resolve to the same colours; the plugin-key check refuses surfaces and statuses.
- TUI: the palette choice from `COLORTERM` / `TERM` / config; frames under the 16-colour palette still tell the cursor row and ticked rows apart.
- Rehearse and Gherkin: their views use identity and severity keys and pass the check.

## Scope

In: the package, the four palettes, aliases, the palette choice, `@zarg/view` and the TUI reading from it, the plugin-key check, rehearse's and gherkin's views on identity keys.

Out: user themes, a web renderer (the web palette is data only until one exists), per-plugin colour overrides.
