// THROWAWAY MOCKUP (never commit): zarg's conversation always tiled beside the open agent's view.
// Frames: mise x -- bun packages/view-tui/mockups/tiling.tsx
import { testRender } from "@opentui/react/test-utils"

const C = { zarg: "#e8eaed", dim: "#9aa0a6", accent: "#81c995", notice: "#fdd663", you: "#8ab4f8", select: "#3c4043", attn: "#f6ae2d" }

function Conversation(props: { focused: boolean; asking: boolean }) {
  return (
    <box title="zarg" style={{ width: "38%", flexDirection: "column", border: true, borderColor: props.focused ? C.accent : C.dim, paddingLeft: 1 }}>
      <text fg={C.you}>you   rehearse the journeys</text>
      <text fg={C.zarg}>zarg  Run r-3f2a is done: 4 findings wait in tester-1.</text>
      <box style={{ flexGrow: 1 }} />
      {props.asking ? (
        <box title="zarg asks" style={{ flexDirection: "column", border: true, borderColor: C.attn, flexShrink: 0 }}>
          <text fg={C.zarg}>What do you want to work on?</text>
          <text fg={C.accent}>› Review tester-1's findings (rec.)</text>
          <text fg={C.zarg}>  Walk a new journey</text>
          <text fg={C.zarg}>  Something else…</text>
          <text fg={C.zarg}>  Chat about this</text>
        </box>
      ) : (
        <box title="Message" style={{ border: true, borderColor: C.dim, height: 3, flexShrink: 0 }}>
          <text fg={C.dim}>type a message</text>
        </box>
      )}
    </box>
  )
}

function Tester(props: { focused: boolean }) {
  return (
    <box title="tester-1 · The developer" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: props.focused ? C.accent : C.dim }}>
      <text fg={C.zarg} wrapMode="none"> ██████████████  22/22 steps   4 flagged</text>
      <box title="Steps" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.dim, paddingLeft: 1 }}>
        <text fg={C.dim} wrapMode="none">✓ UX-0012: feel 1.62, fail 0.18</text>
        <text fg={C.notice} wrapMode="none">⚑ UX-0015: feel 1.05 → 1 finding</text>
      </box>
      <box title="[Findings (4)]  Likes (1)" style={{ flexDirection: "column", border: true, borderColor: props.focused ? C.accent : C.dim, paddingLeft: 1, flexShrink: 0 }}>
        <text wrapMode="none" fg={C.accent} bg={C.select}>▸ [x] R-1a7a9ca8  friction  UX-0015</text>
        <text wrapMode="none" fg={C.zarg}>  [ ] R-07eb8e72  gap       UX-0017</text>
        <text wrapMode="none" fg={C.zarg}>  [x] R-1ed10eab  friction  UX-0017</text>
        <text fg={C.dim} wrapMode="none">space/click select · a Apply · d Dismiss</text>
      </box>
    </box>
  )
}

function Agents(props: { focused: boolean }) {
  const rows = [
    { t: "◆ zarg          asks: What next?", c: C.attn },
    { t: "  └ ● rlm-2     turn 3/15", c: C.zarg },
    { t: "✓ rehearse r-3f2a", c: C.dim },
    { t: "  └ ◆ tester-1  4 to review", c: C.attn, sel: true },
  ]
  return (
    <box title="Agents ◆2" style={{ width: 30, flexDirection: "column", border: true, borderColor: props.focused ? C.accent : C.dim }}>
      {rows.map((r) => (
        <text key={r.t} fg={r.c} wrapMode="none" {...(r.sel ? { bg: C.select } : {})}>{r.t}</text>
      ))}
    </box>
  )
}

/** A: three tiles side by side: zarg | the open agent | agents. */
const Wide = (p: { focus: "zarg" | "view" }) => (
  <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <Conversation focused={p.focus === "zarg"} asking={true} />
      <Tester focused={p.focus === "view"} />
      <Agents focused={false} />
    </box>
    <text fg={C.dim} wrapMode="none">Ctrl-W w next tile · Ctrl-W o only this tile · Ctrl-W = even · Tab sections · g next ◆</text>
  </box>
)

/** B: narrow terminal: zarg on top, the open agent below; the agents tree folds to a strip. */
const Narrow = () => (
  <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
    <text fg={C.attn} wrapMode="none">Agents ◆2 │ ◆ zarg asks │ ✓ rehearse │ ◆ tester-1 (open) │ ● rlm-2</text>
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ height: "45%", flexDirection: "row" }}>
        <box title="zarg" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.dim, paddingLeft: 1 }}>
          <text fg={C.zarg}>zarg  Run r-3f2a is done: 4 findings wait in tester-1.</text>
          <text fg={C.attn}>◆ asks: What do you want to work on?  (Ctrl-W k to answer)</text>
        </box>
      </box>
      <Tester focused={true} />
    </box>
    <text fg={C.dim} wrapMode="none">Ctrl-W w next tile · Ctrl-W o only this tile · g next ◆</text>
  </box>
)

for (const [name, El, w, h] of [
  ["A. wide: zarg | open agent | agents (zarg focused)", () => <Wide focus="zarg" />, 130, 22],
  ["B. narrow: zarg above the open agent, agents as a strip", Narrow, 80, 24],
] as const) {
  const t = await testRender(<El />, { width: w, height: h, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  console.log(`\n=== ${name} ===\n${t.captureCharFrame()}`)
  t.renderer.destroy()
}
