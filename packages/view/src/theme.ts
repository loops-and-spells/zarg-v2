/** zarg's one theme: the colours every platform draws with. Plugins name tones, never colours. */
export const THEME = { bg: "#0f1115", raised: "#161a21", line: "#262b35", text: "#d7dce2", dim: "#6b7280", faint: "#3b4150", accent: "#7aa2f7", attention: "#e0af68", ok: "#9ece6a", error: "#f7768e", selection: "#1f2533", shade: "#1a1f28" } as const
export type ThemeToken = keyof typeof THEME
const TONE: Readonly<Record<string, ThemeToken>> = { normal: "text", ok: "ok", warn: "attention", error: "error", dim: "dim", accent: "accent" }
export const toneToken = (tone: unknown): ThemeToken => (typeof tone === "string" ? (TONE[tone] ?? "text") : "text")
export const toneColor = (tone: unknown) => THEME[toneToken(tone)]
