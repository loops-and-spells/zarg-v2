import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Panel, Session } from "@zarg/client"
import { hintsOf, pickRow, startUi } from "@zarg/view"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { registerCommands } from "./commands"
import { onKey, SHELL } from "./layers"
import { AgentView, type Scroller } from "./sections"
import {
  type Action,
  activate,
  agentDetail,
  agentRows,
  animating,
  answeringOther,
  attentionOf,
  barLine,
  conversation,
  focusBar,
  panelsShown,
  initialUi,
  inputFocused,
  type Meta,
  onSubmit,
  OTHER,
  pickerRows,
  queueOf,
  sheetShown,
  slashActive,
  slashBox,
  statusLine,
  syncUi,
  titleHot,
  typing,
  type Ui,
  working,
} from "./view"

const COLORS = { you: "#8ab4f8", zarg: "#e8eaed", error: "#f28b82", notice: "#fdd663", dim: "#9aa0a6", accent: "#81c995", select: "#3c4043", hot: "#8ab4f8", popover: "#2d2f31", sheet: "#202124" }
const TONE = { running: COLORS.zarg, done: COLORS.dim, failed: COLORS.error, stopped: COLORS.notice }
const BAR_TONE = { question: COLORS.notice, working: COLORS.accent, reply: COLORS.dim, idle: COLORS.dim }
const AGENTS_WIDTH = 30

/** A panel's name with its Alt letter coloured and underlined, then the chord. */
const Title = (p: { readonly name: string; readonly letter: string; readonly focused: boolean; readonly extra?: string }) => {
  const t = titleHot(p.name, p.letter)
  const fg = p.focused ? COLORS.accent : COLORS.dim
  return (
    <text wrapMode="none" truncate>
      <span fg={fg}>{t.before}</span>
      <span fg={COLORS.hot}>
        <u>{t.letter}</u>
      </span>
      <span fg={fg}>{t.after}</span>
      <span fg={COLORS.dim}>{` alt+${p.letter}${p.extra ?? ""}`}</span>
    </text>
  )
}

/**
 * The zarg TUI: the agents list on the left, the open agent's view (or zarg's sheet) in the tile area, the message
 * bar under it, grant popovers over everything, and the status line.
 */
export const App = (props: { readonly session: Session; readonly meta: Meta; readonly onExit: () => void }) => {
  const s = useSyncExternalStore(props.session.subscribe, props.session.state)
  // UI state lives in a ref so several keys in one frame each see the previous key's result.
  const uiRef = useRef<Ui>(initialUi)
  const [, rerender] = useState(0)
  const [draft, setDraftState] = useState("")
  // The draft in a ref too: the keyboard handler reads it between renders (Tab completes it).
  const draftRef = useRef("")
  const inputRef = useRef<InputRenderable | null>(null)
  const agentsRef = useRef<ScrollBoxRenderable | null>(null)
  const talkRef = useRef<ScrollBoxRenderable | null>(null)
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
  // One clock for every animation; it ticks only while something moves.
  const [now, setNow] = useState(Date.now())
  const moving = animating(ui, s)
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [moving])
  const scroller = useRef<Scroller | undefined>(undefined)

  const act = (action: Action | undefined) => {
    if (action === undefined) return
    if (action.type === "answer") props.session.answer(action.answer)
    else if (action.type === "send") props.session.send(action.text)
    else if (action.type === "command") props.session.command(action.text)
    else if (action.type === "stop") props.session.stop()
    else if (action.type === "scroll") scroller.current?.(action.delta)
    else if (action.type === "scroll-talk") talkRef.current?.scrollBy(action.delta)
    else if (action.type === "answer-prompt") void props.session.answerPrompt(action.id, action.choice)
    else if (action.type === "close-prompt") void props.session.closePrompt(action.id)
    else if (action.type === "answer-agent") {
      const agent = action.agent ?? latest().viewing
      if (agent !== undefined) void props.session.answerAgent(agent, action.question, action.answer)
    } else if (action.type === "act") {
      // A panel, a popover or a plugin sheet names its agent; the open view's agent is the one it started with.
      const agent = action.agent ?? latest().viewing?.split("@")[0]
      if (agent !== undefined) void props.session.act(agent, action.action, action.section, action.rows)
    } else if (action.type === "exit") props.onExit()
  }

  useKeyboard((key) => {
    const r = onKey(latest(), props.session.state(), { name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta || key.option }, Date.now(), draftRef.current)
    setUi(r.ui)
    if (r.draft !== undefined) {
      // Write into the input now, so a key typed right after Tab lands after the completion.
      if (inputRef.current !== null) inputRef.current.value = r.draft
      setDraft(r.draft)
    }
    act(r.action)
  })

  const dims = useTerminalDimensions()
  const narrow = dims.width < 100
  const viewing = ui.viewing
  const inquiry = s.thread.pendingInquiry
  const box = slashActive(ui, s) ? slashBox(draft, ui) : undefined
  const width = Math.max(0, ...(box?.rows ?? []).map((r) => r.label.length))
  // Agents spin only while the clock runs (not while a question waits on you).
  const agents = agentRows(s.thread.rlms, ui.agents, AGENTS_WIDTH - 3, moving ? now : undefined, ui.seen)
  const cursor = agents.find((a) => a.selected)?.id
  const detail = agentDetail(s.thread.rlms, cursor)
  // Keep the highlighted row on screen as the cursor moves through a tall tree.
  useEffect(() => {
    if (cursor !== undefined) agentsRef.current?.scrollChildIntoView(`agent-${cursor}`)
  }, [cursor])
  const asking = attentionOf(s.thread.rlms)
  const world = { s, now, draft }

  const agentsList = (
    <box
      // Narrow, the list sits in the tile area: its click must not reach the tile's handler (which would hide it).
      onMouseDown={(e: { stopPropagation: () => void }) => {
        e.stopPropagation()
        setUi({ ...latest(), focus: "agents" })
      }}
      style={{ ...(narrow ? { flexGrow: 1 } : { width: AGENTS_WIDTH, flexShrink: 0 }), flexDirection: "column", border: true, borderColor: ui.focus === "agents" ? COLORS.accent : COLORS.dim }}
    >
      <Title name={`Agents${asking.length > 0 ? ` ◆${asking.length}` : ""}`} letter="a" focused={ui.focus === "agents"} />
      {/* Never focusable: the shell's layers alone decide where keys go (a click must not hand a scrollbox the arrows). */}
      <scrollbox ref={agentsRef} focusable={false} style={{ flexGrow: 1 }}>
        {agents.length === 0 ? <text fg={COLORS.dim}>no agents running</text> : null}
        {agents.map((a) => (
          <text
            key={a.id}
            id={`agent-${a.id}`}
            // An unseen request blinks between the attention colour and plain; a seen one stays in the attention colour.
            fg={a.pulse === "off" ? COLORS.zarg : a.attention ? COLORS.notice : TONE[a.tone]}
            truncate
            // The list's own handler (focus the list) must not run after the row gave its view the keys.
            onMouseDown={(e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              setUi(activate(latest(), props.session.state(), a.id))
            }}
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
  )

  const busyLine = working(ui, s, now)
  // zarg's conversation as a sheet over the tile area: messages, then zarg's question as the picker.
  const sheet = (
    <box style={{ flexGrow: 1, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: ui.focus === "tile" ? COLORS.accent : COLORS.dim }}>
      <text fg={COLORS.dim} wrapMode="none" truncate>
        {`zarg${viewing !== undefined ? "   Esc collapse" : ""}`}
      </text>
      <scrollbox ref={talkRef} focusable={false} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} stickyScroll stickyStart="bottom">
        {conversation(s).map((l, i) => (
          <text key={i} fg={COLORS[l.kind]}>
            {`${l.kind === "you" ? "you" : l.kind === "zarg" ? "zarg" : "!"}  ${l.text}`}
          </text>
        ))}
        {busyLine !== undefined ? <text fg={COLORS.accent}>{busyLine}</text> : null}
      </scrollbox>
      {inquiry !== undefined && ui.chatting !== inquiry.id ? (
        <box style={{ flexDirection: "column", flexShrink: 0, border: ["top"], borderColor: COLORS.accent }}>
          <text fg={COLORS.notice}>{`? ${inquiry.question}`}</text>
          {pickerRows(inquiry, ui.pick).map((r) => (
            <text key={r.id} fg={r.selected ? COLORS.accent : COLORS.zarg}>
              {`${r.selected ? "›" : " "} ${r.label}${r.recommended ? " (recommended)" : ""}${r.selected && r.why !== undefined ? ` — ${r.why}` : ""}${r.selected && r.id === OTHER ? "  (type it below)" : ""}`}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  )

  const view =
    viewing === undefined ? null : (
      <box style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: ui.focus === "tile" ? COLORS.accent : COLORS.dim }}>
        <Title name={viewing} letter="v" focused={ui.focus === "tile"} extra="   Esc close" />
        {s.thread.views?.[viewing] === undefined ? (
          <text fg={COLORS.dim}>no view yet</text>
        ) : (
          <AgentView
            view={s.thread.views[viewing]!}
            ui={ui.view ?? startUi(s.thread.views[viewing]!)}
            height={Math.max(8, dims.height - 8)}
            scroller={scroller}
            onPick={(section, i) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), focus: "tile", view: pickRow(v, latest().view ?? startUi(v), section, i) })
            }}
          />
        )}
      </box>
    )

  const chatting = inquiry !== undefined && ui.chatting === inquiry.id
  const label = answeringOther(ui, s) ? "answer ›" : chatting ? "chat ›" : "message ›"
  const line = barLine(ui, s, now)
  const bar = (
    <box onMouseDown={() => setUi(focusBar(latest(), props.session.state()))} style={{ height: 3, flexShrink: 0, flexDirection: "row", border: true, borderColor: ui.focus === "bar" ? COLORS.accent : COLORS.dim }}>
      {typing(ui, s) ? (
        <>
          <text fg={COLORS.accent} wrapMode="none">{`${label} `}</text>
          <input
            ref={inputRef}
            focused={inputFocused(ui, s)}
            value={draft}
            placeholder={answeringOther(ui, s) ? "your own answer, Enter to send" : chatting ? "ask about the question; Esc goes back to the options" : "type a message, Enter to send"}
            style={{ flexGrow: 1 }}
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
        </>
      ) : (
        <text wrapMode="none" truncate>
          {line.tone === "idle" ? (
            <span fg={COLORS.hot}>
              <u>m</u>
            </span>
          ) : null}
          <span fg={BAR_TONE[line.tone]}>{line.tone === "idle" ? line.text.slice(1) : line.text}</span>
        </text>
      )}
    </box>
  )

  const slash =
    box === undefined ? null : (
      <box title={box.title} style={{ border: true, borderColor: box.lint ? COLORS.error : COLORS.dim, flexDirection: "column", flexShrink: 0 }}>
        {box.rows.map((r) => (
          <text key={r.label} fg={r.selected ? COLORS.accent : COLORS.zarg}>
            {`${r.selected ? "›" : " "}${r.label.padEnd(width)}  ${r.desc}`}
          </text>
        ))}
        {box.hint !== undefined ? <text fg={COLORS.dim}>{` ${box.hint}`}</text> : null}
        {box.lint !== undefined ? <text fg={COLORS.error}>{`✗ ${box.lint}`}</text> : null}
      </box>
    )

  // Narrow: the agents fold to one line of their rows, attention first.
  const rest = agents.filter((a) => !a.attention).map((a) => a.id)
  const stripText = [asking.length > 0 ? `◆${asking.length} ${asking.map((a) => a.id).join(", ")}` : "", ...rest].filter((x) => x.length > 0).join(" │ ")
  const strip = stripText.length > dims.width - 16 ? `${stripText.slice(0, dims.width - 17)}…` : stripText

  const queue = queueOf(ui, s)
  const head = queue[0]
  const popWidth = Math.min(60, dims.width - 4)
  const headView = head?.kind === "surface" && head.view !== undefined ? s.thread.views?.[head.view] : undefined
  const popover =
    head === undefined ? null : head.kind === "surface" ? (
      // A plugin's popover: its view, over everything; Esc closes it.
      <box
        style={{ position: "absolute", left: Math.max(0, Math.floor((dims.width - popWidth) / 2)), top: 3, width: popWidth, flexDirection: "column", border: true, borderStyle: "double", borderColor: COLORS.accent, backgroundColor: COLORS.popover, paddingLeft: 1 }}
      >
        <text wrapMode="none" truncate>
          <span fg={COLORS.accent}>{head.question}</span>
          <span fg={COLORS.dim}>{queue.length > 1 ? `  1 of ${queue.length}` : ""}</span>
        </text>
        {headView === undefined ? <text fg={COLORS.dim}>no view yet</text> : <AgentView view={headView} ui={ui.popover.view ?? startUi(headView)} height={Math.max(6, Math.floor(dims.height / 2))} />}
        <text fg={COLORS.dim}>Esc close</text>
      </box>
    ) : (
      <box
        style={{ position: "absolute", left: Math.max(0, Math.floor((dims.width - popWidth) / 2)), top: 3, width: popWidth, flexDirection: "column", border: true, borderStyle: "double", borderColor: COLORS.notice, backgroundColor: COLORS.popover, paddingLeft: 1 }}
      >
        <text wrapMode="none" truncate>
          <span fg={COLORS.notice}>grant</span>
          <span fg={COLORS.dim}>{queue.length > 1 ? `  1 of ${queue.length} · next: ${queue[1]!.question.slice(0, 30)}` : ""}</span>
        </text>
        <text fg={COLORS.zarg}>{head.question}</text>
        <box style={{ flexDirection: "row", height: 1 }}>
          {head.options.map((o, i) => (
            <text key={o.id} fg={COLORS.zarg} onMouseDown={() => act({ type: "answer-prompt", id: head.id, choice: o.id })} {...(i === Math.min(ui.popover.pick, head.options.length - 1) ? { bg: COLORS.select } : {})}>
              {`${i === ui.popover.pick ? "›" : " "} ${o.label}   `}
            </text>
          ))}
        </box>
        <text fg={COLORS.dim}>←→ pick · Enter choose</text>
      </box>
    )

  // Panels at the tile area's edges: a header with its name and a × that closes it, then its view.
  const shown = panelsShown(ui, s)
  const panelBox = (p: Panel) => {
    const v = s.thread.views?.[p.view]
    const focusedHere = ui.focus === "panel" && ui.panel === p.id
    const size = p.edge === "right" ? { width: p.size + 2, flexShrink: 0 } : { height: p.size + 3, flexShrink: 0 }
    return (
      <box
        key={p.id}
        onMouseDown={(e: { stopPropagation: () => void }) => {
          e.stopPropagation()
          if (p.input === "onFocus") setUi({ ...latest(), focus: "panel", panel: p.id })
        }}
        style={{ ...size, flexDirection: "column", border: true, borderColor: focusedHere ? COLORS.accent : COLORS.dim }}
      >
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={COLORS.dim} wrapMode="none">{`${p.name} `}</text>
          <text
            fg={COLORS.dim}
            onMouseDown={(e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              const u = latest()
              setUi({ ...u, closedPanels: [...u.closedPanels, p.id], ...(u.panel === p.id ? { focus: "tile" as const } : {}) })
            }}
          >
            ×
          </text>
        </box>
        {v === undefined ? null : <AgentView view={v} ui={focusedHere ? (ui.panelView ?? startUi(v)) : startUi(v)} height={p.size} />}
      </box>
    )
  }
  // A plugin's sheet over the tile area: its view, rounded like zarg's.
  const sheetViewState = ui.sheetOf !== undefined ? s.thread.views?.[ui.sheetOf] : undefined
  const pluginSheet = (
    <box style={{ flexGrow: 1, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: ui.focus === "tile" ? COLORS.accent : COLORS.dim }}>
      <text fg={COLORS.dim} wrapMode="none" truncate>{`${ui.sheetOf ?? ""}   Esc close`}</text>
      {sheetViewState === undefined ? <text fg={COLORS.dim}>no view yet</text> : <AgentView view={sheetViewState} ui={ui.sheetView ?? startUi(sheetViewState)} height={Math.max(6, dims.height - 8)} />}
    </box>
  )

  const hints = hintsOf(SHELL, ui, world)
    .map((h) => `${h.keys} ${h.does}`)
    .join(" · ")
  const status = [statusLine(s, props.meta), ...(s.notice !== undefined ? [s.notice] : []), hints].join("   ")

  return (
    <box style={{ flexDirection: "row", width: "100%", height: "100%" }}>
      {narrow ? null : agentsList}
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        {narrow ? (
          <box onMouseDown={() => setUi({ ...latest(), focus: "agents" })} style={{ height: 1, flexShrink: 0 }}>
            <Title name={`Agents ${strip}`} letter="a" focused={ui.focus === "agents"} />
          </box>
        ) : null}
        <box onMouseDown={() => setUi({ ...latest(), focus: "tile" })} style={{ flexGrow: 1, flexDirection: "column" }}>
          {shown.top.map(panelBox)}
          <box style={{ flexGrow: 1, flexDirection: "row" }}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>{narrow && ui.focus === "agents" ? agentsList : ui.sheet && ui.sheetOf !== undefined ? pluginSheet : sheetShown(ui) ? sheet : view}</box>
            {shown.right.map(panelBox)}
          </box>
          {shown.bottom.map(panelBox)}
        </box>
        {slash}
        {bar}
        <box style={{ height: 1, flexShrink: 0 }}>
          <text fg={COLORS.dim} wrapMode="none" truncate>
            {status}
          </text>
        </box>
      </box>
      {popover}
    </box>
  )
}
