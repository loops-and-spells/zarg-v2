import { createContext, useContext } from "react"
import { makeTheme, PALETTES, type Theme } from "@zarg/tokens"

export type ThemeService = Theme["Service"]
/** Today's colours: the truecolor palette (tests, and a tree rendered without a theme). */
export const DEFAULT_THEME = makeTheme(PALETTES["terminal.truecolor"], "terminal.truecolor")
export const ThemeContext = createContext<ThemeService>(DEFAULT_THEME)
export const useTheme = () => useContext(ThemeContext)
/** The colours by the names the TUI has always used. */
export const colorsOf = (t: ThemeService) => ({
  bg: t.value("ground").fg,
  raised: t.value("raised").fg,
  line: t.value("line").fg,
  text: t.value("text").fg,
  dim: t.value("dim").fg,
  faint: t.value("faint").fg,
  accent: t.value("accent").fg,
  attention: t.value("attention").fg,
  ok: t.value("ok").fg,
  error: t.value("error").fg,
  selection: t.value("selection").fg,
  shade: t.value("shade").fg,
})
export const useColors = () => colorsOf(useTheme())
/** A plugin's tone as a colour. */
export const toneFg = (t: ThemeService, tone: unknown) => t.value(t.tone(tone)).fg
/** A plugin's tone as a colour, from the theme in context. */
export const useToneFg = () => {
  const t = useTheme()
  return (tone: unknown) => toneFg(t, tone)
}
