import { useKeyboard } from "@opentui/react"
import { useRef, useState, useSyncExternalStore } from "react"
import type { Session } from "@zarg/client"
import { type Action, conversation, initialUi, inputFocused, type Meta, onKey, onSubmit, pickerRows, statusLine, syncUi, tree, type Ui } from "./view"

const COLORS = { you: "#8ab4f8", zarg: "#e8eaed", error: "#f28b82", notice: "#fdd663", dim: "#9aa0a6", accent: "#81c995" }

/** The zarg TUI: conversation, inline inquiry picker, input line, agents pane and status line. */
export const App = (props: { readonly session: Session; readonly meta: Meta; readonly onExit: () => void }) => {
  const s = useSyncExternalStore(props.session.subscribe, props.session.state)
  // UI state lives in a ref so several keys in one frame each see the previous key's result.
  const uiRef = useRef<Ui>(initialUi)
  const [, rerender] = useState(0)
  const [draft, setDraft] = useState("")
  const latest = () => (uiRef.current = syncUi(uiRef.current, props.session.state()))
  const setUi = (next: Ui) => {
    uiRef.current = next
    rerender((n) => n + 1)
  }
  const ui = latest()

  const act = (action: Action | undefined) => {
    if (action === undefined) return
    if (action.type === "answer") props.session.answer(action.answer)
    else if (action.type === "send") props.session.send(action.text)
    else if (action.type === "command") props.session.command(action.text)
    else if (action.type === "stop") props.session.stop()
    else props.onExit()
  }

  useKeyboard((key) => {
    const r = onKey(latest(), props.session.state(), { name: key.name, ctrl: key.ctrl }, Date.now())
    setUi(r.ui)
    act(r.action)
  })

  const inquiry = s.thread.pendingInquiry
  const lines = conversation(s)
  const agents = tree(s.thread.rlms)
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <scrollbox
          title="Conversation"
          style={{ flexGrow: 1, border: true, borderColor: ui.focus === "conversation" ? COLORS.accent : COLORS.dim }}
          stickyScroll
          stickyStart="bottom"
        >
          {lines.map((l, i) => (
            <text key={i} fg={COLORS[l.kind]}>
              {`${l.kind === "you" ? "you" : l.kind === "zarg" ? "zarg" : "!"}  ${l.text}`}
            </text>
          ))}
        </scrollbox>
        <scrollbox title="Agents" focused={ui.focus === "agents"} style={{ width: 48, border: true, borderColor: ui.focus === "agents" ? COLORS.accent : COLORS.dim }}>
          {agents.length === 0 ? <text fg={COLORS.dim}>no agents running</text> : null}
          {agents.map((a, i) => (
            <text key={i} fg={a.kind === "decision" ? COLORS.dim : COLORS.zarg}>
              {`${"  ".repeat(a.depth)}${a.kind === "decision" ? "· " : ""}${a.text}`}
            </text>
          ))}
        </scrollbox>
      </box>
      {inquiry !== undefined ? (
        <box title="Question" style={{ border: true, borderColor: COLORS.accent, flexDirection: "column", flexShrink: 0 }}>
          <text fg={COLORS.zarg}>{inquiry.question}</text>
          {pickerRows(inquiry, ui.pick).map((r) => (
            <text key={r.id} fg={r.selected ? COLORS.accent : COLORS.zarg}>
              {`${r.selected ? "›" : " "} ${r.label}${r.recommended ? " (recommended)" : ""}${r.selected && r.why !== undefined ? ` — ${r.why}` : ""}`}
            </text>
          ))}
        </box>
      ) : null}
      <box title={ui.other ? "Your answer" : "Message"} style={{ border: true, height: 3, flexShrink: 0 }}>
        <input
          focused={inputFocused(ui, s)}
          value={draft}
          placeholder={inquiry !== undefined && !ui.other ? "choose above, or pick Something else…" : "type a message, Enter to send"}
          onInput={setDraft}
          // The input passes its value; the prop's type also admits DOM's SubmitEvent, hence `unknown`.
          onSubmit={(value: unknown) => {
            const r = onSubmit(latest(), props.session.state(), String(value))
            setUi(r.ui)
            if (r.action !== undefined) setDraft("")
            act(r.action)
          }}
        />
      </box>
      <box style={{ height: 1, flexShrink: 0 }}>
        <text fg={COLORS.dim}>{`${statusLine(s, props.meta)}   ^C stop · ^C^C exit · Tab agents`}</text>
      </box>
    </box>
  )
}
