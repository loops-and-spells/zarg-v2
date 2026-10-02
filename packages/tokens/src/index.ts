/**
 * zarg's design tokens: one set of keys every platform and plugin uses. A platform-free Theme maps keys to colour
 * names (aliases resolve once, the same everywhere); a Palette gives each colour name its value on one platform.
 */
import { Config, Context, Effect, Layer } from "effect"

export type ColorName = "ink" | "slate.950" | "slate.900" | "slate.850" | "slate.800" | "slate.700" | "gray.400" | "gray.500" | "gray.600" | "blue" | "amber" | "green" | "red"
/** A colour on a platform; where colours run out (16 colours), weight tells things apart. */
export interface ColorValue {
  readonly fg: string
  readonly bold?: true
  readonly faint?: true
}
export type Platform = "terminal.truecolor" | "terminal.ansi256" | "terminal.ansi16" | "web.dark" | "web.light"

/** Base keys name a colour. */
export const BASE = {
  ground: "slate.950",
  raised: "slate.900",
  shade: "slate.850",
  selection: "slate.800",
  line: "slate.700",
  text: "ink",
  dim: "gray.500",
  faint: "gray.600",
  accent: "blue",
  attention: "amber",
  ok: "green",
  error: "red",
} as const satisfies Record<string, ColorName>
export type BaseKey = keyof typeof BASE
/** Every other key aliases a base key: identity, severity, status, syntax. */
export const ALIASES = {
  scenario: "attention",
  state: "text",
  persona: "accent",
  journey: "ok",
  agent: "text",
  zarg: "accent",
  "severity.high": "error",
  "severity.medium": "attention",
  "severity.low": "dim",
  running: "accent",
  asks: "attention",
  done: "dim",
  failed: "error",
  keyword: "accent",
  comment: "dim",
  string: "ok",
  number: "attention",
} as const satisfies Record<string, BaseKey>
export type TokenKey = BaseKey | keyof typeof ALIASES
/** What a plugin may name: intent, identity, severity, and dim. The shell alone names surfaces, text and status. */
const PLUGIN_KEY_LIST = ["accent", "attention", "ok", "error", "dim", "scenario", "state", "persona", "journey", "agent", "zarg", "severity.high", "severity.medium", "severity.low"] as const
export const PLUGIN_KEYS: ReadonlySet<string> = new Set(PLUGIN_KEY_LIST)
/** Every tone a plugin may name: its keys, then the old tone names not already keys. */
export const PLUGIN_TONES = [...PLUGIN_KEY_LIST, "normal", "warn"] as const
export type PluginTone = (typeof PLUGIN_TONES)[number]
/** The tones plugins named before tokens, as keys. */
export const OLD_TONES: Readonly<Record<string, TokenKey>> = { normal: "text", ok: "ok", warn: "attention", error: "error", dim: "dim", accent: "accent" }

const TRUECOLOR: Readonly<Record<ColorName, string>> = {
  ink: "#d7dce2",
  "slate.950": "#0f1115",
  "slate.900": "#161a21",
  "slate.850": "#1a1f28",
  "slate.800": "#1f2533",
  "slate.700": "#262b35",
  "gray.400": "#8a93a3",
  "gray.500": "#6b7280",
  "gray.600": "#3b4150",
  blue: "#7aa2f7",
  amber: "#e0af68",
  green: "#9ece6a",
  red: "#f7768e",
}
export const COLOR_NAMES = Object.keys(TRUECOLOR) as ReadonlyArray<ColorName>
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
/** xterm's 256 colours past the 16 system ones: a 6×6×6 cube, then 24 greys. */
const XTERM_256: ReadonlyArray<string> = (() => {
  const lv = [0, 95, 135, 175, 215, 255]
  const cube = lv.flatMap((r) => lv.flatMap((g) => lv.map((b) => hex(r, g, b))))
  const greys = Array.from({ length: 24 }, (_, i) => hex(8 + i * 10, 8 + i * 10, 8 + i * 10))
  return [...cube, ...greys]
})()
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
/** The nearest of the colours given (squared RGB distance). */
const nearest = (h: string, among: ReadonlyArray<string>) => {
  const [r, g, b] = rgb(h)
  let best = among[0]!
  let bestD = Infinity
  for (const c of among) {
    const [x, y, z] = rgb(c)
    const d = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2
    if (d < bestD) {
      best = c
      bestD = d
    }
  }
  return best
}
const each = (f: (h: string) => ColorValue) => Object.fromEntries(Object.entries(TRUECOLOR).map(([n, h]) => [n, f(h)])) as Record<ColorName, ColorValue>

export const PALETTES: Readonly<Record<Platform, Readonly<Record<ColorName, ColorValue>>>> = {
  "terminal.truecolor": each((h) => ({ fg: h })),
  "terminal.ansi256": each((h) => ({ fg: nearest(h, XTERM_256) })),
  // 16 colours, colour alone (the TUI draws fg only): the slates collapse to black, the cursor row is navy so grey
  // text stays readable on it, and the hues are the bright ones so they read on black.
  "terminal.ansi16": {
    ink: { fg: "#c0c0c0" },
    "slate.950": { fg: "#000000" },
    "slate.900": { fg: "#000000" },
    "slate.850": { fg: "#000000" },
    "slate.800": { fg: "#000080" },
    "slate.700": { fg: "#808080" },
    "gray.400": { fg: "#c0c0c0" },
    "gray.500": { fg: "#808080" },
    "gray.600": { fg: "#808080" },
    blue: { fg: "#00ffff" },
    amber: { fg: "#ffff00" },
    green: { fg: "#00ff00" },
    red: { fg: "#ff0000" },
  },
  "web.dark": each((h) => ({ fg: h })),
  // A light ground, the same hues darkened for contrast on it.
  "web.light": {
    ink: { fg: "#1f2328" },
    "slate.950": { fg: "#ffffff" },
    "slate.900": { fg: "#f6f8fa" },
    "slate.850": { fg: "#eef1f5" },
    "slate.800": { fg: "#e3e8ef" },
    "slate.700": { fg: "#d0d7de" },
    "gray.400": { fg: "#59636e" },
    "gray.500": { fg: "#656d76" },
    "gray.600": { fg: "#8c959f" },
    blue: { fg: "#0969da" },
    amber: { fg: "#9a6700" },
    green: { fg: "#1a7f37" },
    red: { fg: "#cf222e" },
  },
}

const paletteOf = (platform: Platform) => ({ platform, color: (name: ColorName): ColorValue => PALETTES[platform][name] })
/** One platform's colours by name. */
export class Palette extends Context.Service<Palette, { readonly platform: Platform; readonly color: (name: ColorName) => ColorValue }>()("@zarg/tokens/Palette") {
  /** One platform's palette (tests, the web, a config setting). */
  static readonly on = (platform: Platform) => Layer.succeed(Palette, paletteOf(platform))
  /** The terminal's: ZARG_THEME_COLORS (truecolor, 256, 16) wins; else COLORTERM; else TERM. (`[theme] colors` in config.toml: not read yet.) */
  static readonly terminal = Layer.effect(
    Palette,
    Effect.gen(function* () {
      const set = yield* Config.String("ZARG_THEME_COLORS").pipe(Config.withDefault(""))
      const colorterm = yield* Config.String("COLORTERM").pipe(Config.withDefault(""))
      const term = yield* Config.String("TERM").pipe(Config.withDefault(""))
      const platform: Platform =
        set === "truecolor" ? "terminal.truecolor"
        : set === "256" ? "terminal.ansi256"
        : set === "16" ? "terminal.ansi16"
        : /^(truecolor|24bit)$/i.test(colorterm) ? "terminal.truecolor"
        : /256color/.test(term) ? "terminal.ansi256"
        : "terminal.ansi16"
      return paletteOf(platform)
    }),
  )
}

/** zarg's theme over a platform's colours: a key, its alias's base key, the base key's colour name, that colour's value. */
export const makeTheme = (colors: Readonly<Record<ColorName, ColorValue>>, platform: Platform) => {
  const base = (key: TokenKey): BaseKey => (key in ALIASES ? ALIASES[key as keyof typeof ALIASES] : (key as BaseKey))
  return {
    platform,
    value: (key: TokenKey): ColorValue => colors[BASE[base(key)]] ?? colors.ink,
    /** A plugin's tone as a key: a plugin key as itself, an old tone by its alias; anything else is plain text. */
    tone: (tone: unknown): TokenKey => (typeof tone !== "string" ? "text" : PLUGIN_KEYS.has(tone) ? (tone as TokenKey) : (OLD_TONES[tone] ?? "text")),
  }
}
export type ThemeService = ReturnType<typeof makeTheme>
export class Theme extends Context.Service<Theme, ThemeService>()("@zarg/tokens/Theme") {
  /** zarg's theme over whatever Palette is provided. */
  static readonly layer = Layer.effect(
    Theme,
    Effect.gen(function* () {
      // Its colours come from whatever Palette is provided (the service, not the table).
      const p = yield* Palette
      return makeTheme(Object.fromEntries(COLOR_NAMES.map((n) => [n, p.color(n)])) as Record<ColorName, ColorValue>, p.platform)
    }),
  )
}
