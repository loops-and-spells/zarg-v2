// THROWAWAY MOCKUP (never commit): the view gets the screen, zarg lives in a chat bar that opens as a sheet,
// grants queue as popovers, attention pulses in the agents list, Alt+letter hotkeys shown in panel names.
// Frames: `mise x -- bun packages/view-tui/mockups/sheet.tsx`. Live (colour, animation, keys 1-5, q quits): add `--live`.
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { useEffect, useState } from "react"

const C = { fg: "#e8eaed", dim: "#6b7075", accent: "#81c995", attn: "#f6ae2d", attnDim: "#7a5a1e", hot: "#8ab4f8", select: "#3c4043", sheet: "#202124", pop: "#2d2f31" }

/** A panel name with its Alt hotkey letter coloured: `[a]gents`. */
const Title = (p: { name: string; hot: string; focused?: boolean }) => {
  const i = p.name.toLowerCase().indexOf(p.hot)
  if (i < 0) return <Title {...p} name={`${p.hot} ${p.name}`} />
  return (
    <text wrapMode="none">
      <span fg={p.focused ? C.accent : C.dim}>{p.name.slice(0, i)}</span>
      <span fg={C.hot}><u>{p.name[i]}</u></span>
      <span fg={p.focused ? C.accent : C.dim}>{p.name.slice(i + 1)}</span>
      <span fg={C.dim}>{` alt+${p.hot}`}</span>
    </text>
  )
}

const Agents = (p: { tick: number; focused?: boolean }) => {
  const on = p.tick % 2 === 0
  return (
    <box style={{ width: 30, flexDirection: "column", border: true, borderColor: p.focused ? C.accent : C.dim, paddingLeft: 1 }}>
      <Title name="Agents ◆1" hot="a" focused={p.focused} />
      <text fg={C.fg} wrapMode="none">● zarg        idle</text>
      <text wrapMode="none" bg={C.select}>
        <span fg={on ? C.attn : C.attnDim}>{on ? "◆" : "◇"}</span>
        <span fg={on ? C.attn : C.fg}>{on ? " REHEARSE" : " rehearse"}</span>
        <span fg={C.attn}>    4 findings</span>
      </text>
      <text fg={C.dim} wrapMode="none">  └ ✓ tester-1  done</text>
      <box style={{ flexGrow: 1 }} />
      <text fg={C.dim} wrapMode="none">↑↓ move · Enter open · g next ◆</text>
    </box>
  )
}

const View = (p: { focused?: boolean }) => (
  <box style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: p.focused ? C.accent : C.dim, paddingLeft: 1 }}>
    <Title name="rehearse r-3f2a" hot="v" focused={p.focused} />
    <text fg={C.fg} wrapMode="none">journeys  [findings]  testers</text>
    <text fg={C.dim} wrapMode="none">  ☐ UX-0012  checkout: no way back from payment</text>
    <text fg={C.dim} wrapMode="none">  ☐ UX-0019  empty cart shows a spinner forever</text>
    <text fg={C.dim} wrapMode="none">  ☐ UX-0023  login error names the wrong field</text>
    <text fg={C.dim} wrapMode="none">  ☐ UX-0031  search ignores the category filter</text>
    <box style={{ flexGrow: 1 }} />
    <text fg={C.dim} wrapMode="none">Tab sections · Space select · a apply · Esc close</text>
  </box>
)

type Bar = "message" | "question" | "typing"
const ChatBar = (p: { mode: Bar; focused?: boolean }) => (
  <box style={{ height: 3, border: true, borderColor: p.focused ? C.accent : C.dim, paddingLeft: 1, flexDirection: "row" }}>
    {p.mode === "question" ? (
      <text wrapMode="none">
        <span fg={C.attn}>? </span>
        <span fg={C.fg}>zarg: Split UX-0012 into two cards?</span>
        <span fg={C.dim}>   alt+m or / to answer</span>
      </text>
    ) : p.mode === "typing" ? (
      <text wrapMode="none">
        <span fg={C.hot}><u>m</u></span>
        <span fg={C.accent}>{"essage › "}</span>
        <span fg={C.fg}>keep them separate, one per outcome█</span>
      </text>
    ) : (
      <text wrapMode="none">
        <span fg={C.hot}><u>m</u></span>
        <span fg={C.dim}>essage zarg… (alt+m or /)</span>
      </text>
    )}
  </box>
)

/** zarg's conversation as a bottom sheet over the view: history, then the picker (or the input). */
const Sheet = () => (
  <box style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 3, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.accent, backgroundColor: C.sheet, paddingLeft: 1 }}>
    <text fg={C.dim} wrapMode="none">───────── zarg ─────────  Esc collapse</text>
    <text fg={C.dim} wrapMode="none">you: rehearse the checkout journey</text>
    <text fg={C.fg} wrapMode="none">zarg: tester-1 found 4 gaps. UX-0012 mixes two</text>
    <text fg={C.fg} wrapMode="none">      outcomes (paid, declined).</text>
    <text fg={C.attn} wrapMode="none">? Split UX-0012 into two cards?</text>
    <text fg={C.fg} wrapMode="none" bg={C.select}>› Yes, one card per outcome   (recommended)</text>
    <text fg={C.fg} wrapMode="none">  Keep as is</text>
    <text fg={C.fg} wrapMode="none">  Something else…</text>
    <text fg={C.dim} wrapMode="none">  Chat about this</text>
    <box style={{ flexGrow: 1 }} />
    <text fg={C.dim} wrapMode="none">↑↓ pick · Enter answer · Esc collapse</text>
  </box>
)

/** The head of the popover queue: FIFO, count in the title. */
const Grant = () => (
  <box style={{ position: "absolute", left: 24, top: 5, width: 52, height: 10, flexDirection: "column", border: true, borderStyle: "double", borderColor: C.attn, backgroundColor: C.pop, paddingLeft: 1 }}>
    <text wrapMode="none"><span fg={C.attn}>grant</span><span fg={C.dim}>  1 of 2 · next: gherkin (files)</span></text>
    <text fg={C.fg} wrapMode="none">rehearse wants:</text>
    <text fg={C.fg} wrapMode="none">  http  api.openrouter.ai</text>
    <text fg={C.fg} wrapMode="none">  graph read</text>
    <box style={{ flexGrow: 1 }} />
    <text fg={C.fg} wrapMode="none" bg={C.select}>› Allow always     Allow once     Deny</text>
    <text fg={C.dim} wrapMode="none">←→ pick · Enter choose · Esc later (stays queued)</text>
  </box>
)

type Frame = { name: string; bar: Bar; focus: "agents" | "view" | "bar"; sheet?: boolean; grant?: boolean }
const FRAMES: ReadonlyArray<Frame> = [
  { name: "1. default: the view gets the screen, zarg is one bar; rehearse pulses (◆/◇, name bright/dim)", bar: "message", focus: "agents" },
  { name: "2. zarg asks: the bar becomes the question, one line", bar: "question", focus: "view" },
  { name: "3. alt+m, / or a click on the bar: zarg's sheet covers the whole tile area (not agents), picker inside", bar: "question", focus: "bar", sheet: true },
  { name: "4. no question, bar focused: typing, sheet closed until you want history (alt+m again)", bar: "typing", focus: "bar" },
  { name: "5. two grants waiting: the first pops over everything, the next waits (FIFO)", bar: "message", focus: "view", grant: true },
]

const Shell = (p: { frame: Frame; tick: number }) => (
  <box style={{ width: "100%", height: "100%", flexDirection: "row", backgroundColor: "#171717" }}>
    <Agents tick={p.tick} focused={p.frame.focus === "agents"} />
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <View focused={p.frame.focus === "view"} />
      <ChatBar mode={p.frame.bar} focused={p.frame.focus === "bar"} />
      {p.frame.sheet ? <Sheet /> : null}
    </box>
    {p.frame.grant ? <Grant /> : null}
  </box>
)

const Live = () => {
  const [i, setI] = useState(0)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])
  useKeyboard((k) => {
    if (k.name === "q") process.exit(0)
    const n = Number(k.name)
    if (n >= 1 && n <= FRAMES.length) setI(n - 1)
  })
  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <text fg={C.hot} wrapMode="none">{`${FRAMES[i]!.name}   (1-5 frames · q quit)`}</text>
      <Shell frame={FRAMES[i]!} tick={tick} />
    </box>
  )
}

if (process.argv.includes("--live")) {
  createRoot(await createCliRenderer({ exitOnCtrlC: true, autoFocus: false })).render(<Live />)
} else {
  for (const f of FRAMES) {
    for (const tick of f.name.startsWith("1.") ? [0, 1] : [0]) {
      const t = await testRender(<Shell frame={f} tick={tick} />, { width: 100, height: 20, exitOnCtrlC: false, exitSignals: [] })
      await t.renderOnce()
      console.log(`\n=== ${f.name}${f.name.startsWith("1.") ? ` (pulse ${tick})` : ""} ===\n${t.captureCharFrame()}`)
      t.renderer.destroy()
    }
  }
}
