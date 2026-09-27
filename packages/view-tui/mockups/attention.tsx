// THROWAWAY MOCKUP (not product code, never commit): the conversational AI as the root agent; other agents ask for attention.
// Frames: mise x -- bun packages/view-tui/mockups/attention.tsx
import { testRender } from "@opentui/react/test-utils"

const C = { zarg: "#e8eaed", dim: "#9aa0a6", accent: "#81c995", notice: "#fdd663", you: "#8ab4f8", select: "#3c4043", attn: "#f6ae2d" }

type Row = { text: string; tone: keyof typeof C; sel?: boolean }
const tree = (open: string, asking = true): ReadonlyArray<Row> => [
  asking ? { text: `${open === "zarg" ? "▸" : " "} ◆ zarg            asks: What next?`, tone: "attn", sel: open === "zarg" } : { text: `${open === "zarg" ? "▸" : " "} ● zarg            talking`, tone: "zarg", sel: open === "zarg" },
  { text: "  └ ● research rlm-2    turn 3/15", tone: "zarg" },
  { text: `${open === "rehearse" ? "▸" : " "} ✓ rehearse run r-3f2a`, tone: "dim", sel: open === "rehearse" },
  { text: `  └ ◆ tester-1 dev      4 findings to review`, tone: "attn", sel: open === "tester-1" },
  { text: "  ◆ plugin vm-grid     wants to load", tone: "attn" },
]

function Agents(props: { open: string; asking?: boolean }) {
  return (
    <box title={`Agents  ◆ ${props.asking === false ? 2 : 3} need you`} style={{ width: 44, flexDirection: "column", border: true, borderColor: C.dim }}>
      {tree(props.open, props.asking !== false).map((r) => (
        <text key={r.text} fg={C[r.tone]} wrapMode="none" {...(r.sel ? { bg: C.select } : {})}>
          {r.text}
        </text>
      ))}
    </box>
  )
}

/** Frame 1: the root agent's view is the conversation: messages, then its question OR the message input (never both). */
function Conversation(props: { asking: boolean }) {
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box title="zarg · conversation" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.accent, paddingLeft: 1 }}>
          <text fg={C.you}>you   rehearse the journeys</text>
          <text fg={C.zarg}>zarg  Rehearse run r-3f2a is done: 4 findings wait in tester-1.</text>
          {props.asking ? <text fg={C.zarg}>zarg  Nothing is open in the requirements.</text> : <text fg={C.you}>you   Review tester-1's findings</text>}
          {props.asking ? null : <text fg={C.zarg}>zarg  Open tester-1 (◆ in Agents) and apply the ones you want; I take them up after.</text>}
          <box style={{ flexGrow: 1 }} />
          {props.asking ? (
            <box title="zarg asks" style={{ flexDirection: "column", border: true, borderColor: C.attn, flexShrink: 0 }}>
              <text fg={C.zarg}>What do you want to work on?</text>
              <text fg={C.accent}>› Review tester-1's findings (recommended) — 4 wait for you</text>
              <text fg={C.zarg}>  Walk a new journey</text>
              <text fg={C.zarg}>  Something else…</text>
              <text fg={C.zarg}>  Chat about this</text>
            </box>
          ) : (
            <box title="Message" style={{ border: true, borderColor: C.dim, height: 3, flexShrink: 0 }}>
              <text fg={C.dim}>type a message, Enter to send</text>
            </box>
          )}
        </box>
        <Agents open="zarg" asking={props.asking} />
      </box>
      <text fg={C.dim}>◆ tester-1: 4 findings to review   ◆ vm-grid wants to load   ·  Tab agents  ·  g go to next ◆</text>
    </box>
  )
}

/** Frame 2: an agent's view is open; the conversation's question is not here, only a call to action. */
function AgentOpen() {
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box title="tester-1 · The developer · Esc back" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.accent }}>
          <box style={{ flexShrink: 0, paddingLeft: 1, backgroundColor: "#3a2f10" }}>
            <text fg={C.attn} wrapMode="none">◆ zarg asks: What do you want to work on?   Enter answer · Esc later</text>
          </box>
          <text fg={C.zarg}> ████████████████████████  22/22 steps   4 flagged</text>
          <box title="Steps" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.dim, paddingLeft: 1 }}>
            <text fg={C.dim}>✓ UX-0012: feel 1.62, fail 0.18</text>
            <text fg={C.notice}>⚑ UX-0015: feel 1.05, fail 0.22 → flagged feel → 1 finding</text>
          </box>
          <box title="[Findings (4)]  Likes (1)" style={{ flexDirection: "column", border: true, borderColor: C.accent, paddingLeft: 1, flexShrink: 0 }}>
            <text wrapMode="none" fg={C.accent} bg={C.select}>▸ [x] R-1a7a9ca8  friction  UX-0015  medium  fix 0.77  After picking a topic…</text>
            <text wrapMode="none" fg={C.zarg}>  [ ] R-07eb8e72  gap       UX-0017  high    ask 0.73  When the driver finds…</text>
            <text wrapMode="none" fg={C.zarg}>  [x] R-1ed10eab  friction  UX-0017  high    ask 0.60  The choice after this…</text>
            <text fg={C.dim}>↑↓ move · space/click select · a Apply · d Dismiss</text>
          </box>
        </box>
        <Agents open="tester-1" />
      </box>
      <text fg={C.dim}>◆ zarg asks: What next?   ◆ vm-grid wants to load   ·  Tab sections  ·  g go to next ◆  ·  Esc back</text>
    </box>
  )
}

const frames = [
  ["1a. zarg's conversation, a question waiting (no message input)", () => <Conversation asking={true} />],
  ["1b. zarg's conversation, nothing asked (the message input)", () => <Conversation asking={false} />],
  ["2. an agent open; zarg asks for attention", AgentOpen],
] as const
for (const [name, El] of frames) {
  const t = await testRender(<El />, { width: 120, height: 24, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  console.log(`\n=== ${name} ===\n${t.captureCharFrame()}`)
  t.renderer.destroy()
}
