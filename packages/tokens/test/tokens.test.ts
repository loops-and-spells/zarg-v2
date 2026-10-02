import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { ALIASES, BASE, makeTheme, Palette, PALETTES, PLUGIN_KEYS, type Platform, Theme, type TokenKey } from "../src"

const platforms = Object.keys(PALETTES) as ReadonlyArray<Platform>
const keys = [...Object.keys(BASE), ...Object.keys(ALIASES)]
const themeOn = (p: Platform) => Effect.runSync(Effect.gen(function* () { return yield* Theme }).pipe(Effect.provide(Theme.layer.pipe(Layer.provide(Palette.on(p))))))
const choose = (env: Record<string, string>) =>
  Effect.runSync(Effect.gen(function* () { return (yield* Palette).platform }).pipe(Effect.provide(Palette.terminal), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))))

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
    expect(th.value("scenario").fg).toBe(th.value("attention").fg)
    expect(th.value("severity.high").fg).toBe("#f7768e")
    expect(th.value("journey").fg).toBe("#9ece6a")
  })
  test("ansi256 is the nearest xterm colour; ansi16: selection differs from ground", () => {
    // #7aa2f7 = (122,162,247): nearest cube levels 135,175,255 → #87afff (checked by hand).
    expect(themeOn("terminal.ansi256").value("accent").fg).toBe("#87afff")
    const t16 = themeOn("terminal.ansi16")
    expect(t16.value("selection").fg).not.toBe(t16.value("ground").fg)
  })
  test("on every palette, text and every plugin key stays readable on the cursor row (differs from selection)", () => {
    for (const p of Object.keys(PALETTES) as ReadonlyArray<Platform>) {
      const t = makeTheme(PALETTES[p], p)
      for (const k of ["text", "faint", ...PLUGIN_KEYS] as ReadonlyArray<TokenKey>) expect(`${p} ${k} ${t.value(k).fg}`).not.toBe(`${p} ${k} ${t.value("selection").fg}`)
    }
  })
  test("no palette leans on weight: colour alone tells keys apart (platforms draw fg only)", () => {
    for (const p of Object.values(PALETTES)) for (const v of Object.values(p)) expect(v.bold === undefined && v.faint === undefined).toBe(true)
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
