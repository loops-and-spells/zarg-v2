/** xterm.js's default colours: the 16 ANSI ones, the 6×6×6 cube, then 24 greys (indices 0–255). */
const ANSI = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"]
const hex = (n: number) => n.toString(16).padStart(2, "0")
const LEVELS = [0, 95, 135, 175, 215, 255]
const CUBE = Array.from({ length: 216 }, (_, i) => `#${hex(LEVELS[Math.floor(i / 36)]!)}${hex(LEVELS[Math.floor(i / 6) % 6]!)}${hex(LEVELS[i % 6]!)}`)
const GREYS = Array.from({ length: 24 }, (_, i) => `#${hex(8 + 10 * i).repeat(3)}`)
export const PALETTE: ReadonlyArray<string> = [...ANSI, ...CUBE, ...GREYS]
