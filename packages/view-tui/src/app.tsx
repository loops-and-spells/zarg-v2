import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Session } from "@zarg/client"
import { pickRow, startUi } from "@zarg/view"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { registerCommands } from "./commands"
import { AgentView, type Scroller } from "./sections"
import { type Action, agentDetail, agentRows, animating, conversation, activate, messageShown, OTHER, otherFocused, working, initialUi, inputFocused, type Meta, onKey, onSubmit, pickerRows, slashActive, slashBox, statusLine, syncUi, type Ui } from "./view"

const COLORS = { you: "#8ab4f8", zarg: "#e8eaed", error: "#f28b82", notice: "#fdd663", dim: "#9aa0a6", accent: "#81c995", select: "#3c4043" }
const TONE = { running: COLORS.zarg, done: COLORS.dim, failed: COLORS.error, stopped: COLORS.notice }

/** The zarg TUI: conversation, inline inquiry picker, input line, agents pane and status line. */
export const App = (props: { readonly session: Session; readonly meta: Meta; readonly onExit: () => void }) => {
  const s = useSyncExternalStore(props.session.subscribe, props.session.state)
  // UI state lives in a ref so several keys in one frame each see the previous key's result.
  const uiRef = useRef<Ui>(initialUi)
  const [, rerender] = useState(0)
  const [draft, setDraftState] = useState("")
  // The draft in a ref too: the keyboard handler reads it between renders (Tab completes it).
  const draftRef = useRef("")
  const inputRef = useRef<InputRenderable | null>(null)
  // The picker's Something else… line has its own text.
  const [otherDraft, setOtherDraft] = useState("")
  const agentsRef = useRef<ScrollBoxRenderable | null>(null)
  const setDraft = (text: string) => {
    draftRef.current = text
    setDraftState(text)
  }
  const latest = () => (uiRef.current = syncUi(uiRef.current, props.session.state()))
  const setUi = (next: Ui) => {
    uiRef.current = next
    rerender((n) => n + 1)
  }
  const ui = latest()
  // Commands loaded plugins add join the input's table (a name already there is skipped).
  registerCommands(props.session.pluginCommands().map(({ cmd, desc, arg }) => ({ cmd, desc, arg })))
  // One clock for every animation; it ticks only while something is running.
  const [now, setNow] = useState(Date.now())
  const moving = animating(ui, s)
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [moving])

  const act = (action: Action | undefined) => {
    if (action === undefined) return
    if (action.type === "answer") props.session.answer(action.answer)
    else if (action.type === "send") props.session.send(action.text)
    else if (action.type === "command") props.session.command(action.text)
    else if (action.type === "stop") props.session.stop()
    else if (action.type === "scroll") scroller.current?.(action.delta)
    else if (action.type === "act") {
      const agent = latest().viewing
      if (agent !== undefined) void props.session.act(agent, action.action, action.section, action.rows)
    }
    else props.onExit()
  }

  useKeyboard((key) => {
    const r = onKey(latest(), props.session.state(), { name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta }, Date.now(), draftRef.current)
    setUi(r.ui)
    if (r.draft !== undefined) {
      // Write into the input now, so a key typed right after Tab lands after the completion.
      if (inputRef.current !== null) inputRef.current.value = r.draft
      setDraft(r.draft)
    }
    act(r.action)
  })

  const viewing = ui.viewing
  const dims = useTerminalDimensions()
  const scroller = useRef<Scroller | undefined>(undefined)

  const inquiry = s.thread.pendingInquiry
  const box = slashActive(ui, s) ? slashBox(draft, ui) : undefined
  const width = Math.max(0, ...(box?.rows ?? []).map((r) => r.label.length))
  const lines = conversation(s)
  // Agents spin only while the clock runs (not while a question waits on you).
  const agents = agentRows(s.thread.rlms, ui.agents, 46, moving ? now : undefined)
  const busyLine = working(ui, s, now)
  const cursor = agents.find((a) => a.selected)?.id
  const detail = agentDetail(s.thread.rlms, cursor)
  // Keep the highlighted row on screen as the cursor moves through a tall tree.
  useEffect(() => {
    if (cursor !== undefined) agentsRef.current?.scrollChildIntoView(`agent-${cursor}`)
  }, [cursor])
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {viewing !== undefined ? (
          <box title={`${viewing} · Esc back`} style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: COLORS.accent }}>
            {s.thread.views?.[viewing] === undefined ? (
              <text fg={COLORS.dim}>no view yet</text>
            ) : (
              <AgentView view={s.thread.views[viewing]!} ui={ui.view ?? startUi(s.thread.views[viewing]!)} height={Math.max(8, dims.height - 3)}
                scroller={scroller}
                onPick={(section, i) => {
                  const v = props.session.state().thread.views?.[viewing]
                  if (v !== undefined) setUi({ ...latest(), view: pickRow(v, latest().view ?? startUi(v), section, i) })
                }}
              />
            )}
          </box>
        ) : (
        <box title="zarg" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: ui.focus === "conversation" ? COLORS.accent : COLORS.dim }}>
          <scrollbox style={{ flexGrow: 1 }} stickyScroll stickyStart="bottom">
            {lines.map((l, i) => (
              <text key={i} fg={COLORS[l.kind]}>
                {`${l.kind === "you" ? "you" : l.kind === "zarg" ? "zarg" : "!"}  ${l.text}`}
              </text>
            ))}
            {busyLine !== undefined ? <text fg={COLORS.accent}>{busyLine}</text> : null}
          </scrollbox>
        {inquiry !== undefined && !messageShown(ui, s) ? (
          <box title="Question" style={{ border: true, borderColor: COLORS.accent, flexDirection: "column", flexShrink: 0 }}>
            <text fg={COLORS.zarg}>{inquiry.question}</text>
            {pickerRows(inquiry, ui.pick).map((r) =>
              r.id === OTHER ? (
                <box key={r.id} style={{ flexDirection: "row", height: 1 }}>
                  <text fg={r.selected ? COLORS.accent : COLORS.zarg}>{`${r.selected ? "›" : " "} ${r.label.replace(/…$/, "")}: `}</text>
                  <input
                    focused={otherFocused(ui, s)}
                    value={otherDraft}
                    placeholder={r.selected ? "type your answer, Enter to send" : ""}
                    style={{ flexGrow: 1 }}
                    onInput={(text: string) => setOtherDraft(text)}
                    onSubmit={(value: unknown) => {
                      const r2 = onSubmit(latest(), props.session.state(), String(value))
                      setUi(r2.ui)
                      if (r2.action !== undefined) setOtherDraft("")
                      act(r2.action)
                    }}
                  />
                </box>
              ) : (
                <text key={r.id} fg={r.selected ? COLORS.accent : COLORS.zarg}>
                  {`${r.selected ? "›" : " "} ${r.label}${r.recommended ? " (recommended)" : ""}${r.selected && r.why !== undefined ? ` — ${r.why}` : ""}`}
                </text>
              ),
            )}
          </box>
        ) : null}
        {box !== undefined ? (
          <box title={box.title} style={{ border: true, borderColor: box.lint ? COLORS.error : COLORS.dim, flexDirection: "column", flexShrink: 0 }}>
            {box.rows.map((r) => (
              <text key={r.label} fg={r.selected ? COLORS.accent : COLORS.zarg}>
                {`${r.selected ? "›" : " "}${r.label.padEnd(width)}  ${r.desc}`}
              </text>
            ))}
            {box.hint !== undefined ? <text fg={COLORS.dim}>{` ${box.hint}`}</text> : null}
            {box.lint !== undefined ? <text fg={COLORS.error}>{`✗ ${box.lint}`}</text> : null}
          </box>
        ) : null}
        {messageShown(ui, s) ? (
        <box title={inquiry !== undefined ? `Chat about: ${inquiry.question}` : "Message"} style={{ border: true, height: 3, flexShrink: 0 }}>
          <input
            ref={inputRef}
            focused={inputFocused(ui, s)}
            value={draft}
            placeholder={inquiry !== undefined ? "ask about the question; Esc goes back to the options" : "type a message, Enter to send"}
            onInput={(text: string) => {
              setDraft(text)
              // Typing picks the box afresh: no highlighted row.
              const u = latest()
              if (u.slash?.sel !== null && u.slash?.sel !== undefined) setUi({ ...u, slash: { sel: null, cycle: u.slash.cycle } })
            }}
            // The input passes its value; the prop's type also admits DOM's SubmitEvent, hence `unknown`.
            onSubmit={(value: unknown) => {
              const r = onSubmit(latest(), props.session.state(), String(value))
              setUi(r.ui)
              if (r.draft !== undefined) setDraft(r.draft)
              else if (r.action !== undefined) setDraft("")
              act(r.action)
            }}
          />
        </box>
        ) : null}
        </box>
        )}
        <box title="Agents" style={{ width: 48, flexDirection: "column", border: true, borderColor: ui.focus === "agents" ? COLORS.accent : COLORS.dim }}>
          <scrollbox ref={agentsRef} style={{ flexGrow: 1 }}>
            {agents.length === 0 ? <text fg={COLORS.dim}>no agents running</text> : null}
            {agents.map((a) => (
              <text
                key={a.id}
                id={`agent-${a.id}`}
                fg={TONE[a.tone]}
                truncate
                onMouseDown={() => setUi(activate(latest(), props.session.state().thread.rlms, a.id))}
                {...((a.selected && ui.focus === "agents") || a.id === viewing ? { bg: COLORS.select } : {})}
              >
                {a.text}
              </text>
            ))}
          </scrollbox>
          {detail.length > 0 ? (
            <box style={{ flexDirection: "column", flexShrink: 0, border: ["top"], borderColor: COLORS.dim }}>
              {detail.map((l, i) => (
                <text key={i} fg={i === 0 ? COLORS.zarg : COLORS.dim} truncate>
                  {l}
                </text>
              ))}
            </box>
          ) : null}
        </box>
      </box>
      <box style={{ height: 1, flexShrink: 0 }}>
        <text fg={COLORS.dim}>{`${statusLine(s, props.meta)}   ${viewing !== undefined ? "Tab sections · [ ] tabs · ↑↓ move · Space select · Esc back" : ui.focus === "agents" ? "↑↓ move · ←→ fold · Enter open, then history · Tab back" : "^C stop · ^C^C exit · Tab agents"}`}</text>
      </box>
    </box>
  )
}
