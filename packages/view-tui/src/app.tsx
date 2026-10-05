import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Panel, Session, Topic } from "@zarg/client"
import { afterAction, applyMenu, closeMenu, pasteText, highlightActs, pickCard, pickChoice, pressAction, hintsOf, keyFor, menuAdjust, pickHeader, pickMark, pickRow, pickTab, startUi } from "@zarg/view"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { registerCommands, SLASH_COMMANDS } from "./commands"
import { fit, gauge, keyGlyphs } from "./look"
import { type Card, gridCards, gridCursor, gridShape } from "./grid"
import { paletteEntries } from "./palette"
import { colorsOf, DEFAULT_THEME, ThemeContext, type ThemeService, toneFg } from "./theme"
import { contextOf, displayName, railRows } from "./rail"
import { reviewActs, reviewGroups } from "./review"
import { Buttons, Heading } from "./sections"
import { RichText } from "./markdown"
import { inboxCursor, inboxRows, openTopicUi, unseenBlocking } from "./inbox-keys"
import { onKey, SHELL } from "./layers"
import { AgentView, NowContext, type Scroller } from "./sections"
import {
  type Action,
  activate,
  agentDetail,
  goHome,
  PULSE_MS,
  ARCHIVED,
  openAgent,
  treeRows,
  animating,
  answeringOther,
  attentionOf,
  barLine,
  conversation,
  closedKey,
  closeOverlays,
  focusBar,
  panelsShown,
  initialUi,
  inputFocused,
  type Meta,
  onSubmit,
  INBOX_ROW,
  OTHER,
  CHAT,
  pickerRows,
  queueOf,
  sheetShown,
  NAV,
  openNav,
  slashActive,
  slashBox,
  statusLine,
  syncUi,
  typing,
  type Ui,
  working,
} from "./view"

const AGENTS_WIDTH = 24

/**
 * The zarg TUI: the agents list on the left, the open agent's view (or zarg's sheet) in the tile area, the message
 * bar under it, grant popovers over everything, and the status line.
 */
/** How long a new notice shows whole on its own line. */
const NOTICE_MS = 10_000

export const App = (props: { readonly session: Session; readonly meta: Meta; readonly onExit: () => void; readonly theme?: ThemeService }) => {
  const theme = props.theme ?? DEFAULT_THEME
  // Every scroll box listens to the renderer (a board has one per lane): past Node's default of 10 it would print a
  // MaxListenersExceededWarning over the screen. Set before any of them mounts.
  const renderer = useRenderer()
  if (renderer.getMaxListeners() < 1000) renderer.setMaxListeners(1000)
  // A press anywhere closes an open column menu, unless it lands on the menu or a header (their handlers run first and set this).
  const keepMenu = useRef(false)
  const dismissMenus = () => {
    const keep = keepMenu.current
    keepMenu.current = false
    const u = uiRef.current
    if (keep || (u.view?.menu ?? u.sheetView?.menu ?? u.panelView?.menu) === undefined) return
    setUi({ ...u, ...(u.view !== undefined ? { view: closeMenu(u.view) } : {}), ...(u.sheetView !== undefined ? { sheetView: closeMenu(u.sheetView) } : {}), ...(u.panelView !== undefined ? { panelView: closeMenu(u.panelView) } : {}) })
  }
  const C = colorsOf(theme)
  const s = useSyncExternalStore(props.session.subscribe, props.session.state)
  // UI state lives in a ref so several keys in one frame each see the previous key's result.
  const uiRef = useRef<Ui>(initialUi)
  const [, rerender] = useState(0)
  const [draft, setDraftState] = useState("")
  // The draft in a ref too: the keyboard handler reads it between renders (Tab completes it).
  const draftRef = useRef("")
  const inputRef = useRef<InputRenderable | null>(null)
  // Set when a key opens the bar; cleared once it has rendered (its input then takes the typing itself).
  const barOpening = useRef(false)
  useEffect(() => {
    barOpening.current = false
  })
  const agentsRef = useRef<ScrollBoxRenderable | null>(null)
  const talkRef = useRef<ScrollBoxRenderable | null>(null)
  const reviewRef = useRef<ScrollBoxRenderable | null>(null)
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
  // A new notice shows whole on its own line for a while, then keeps to the end of the status line.
  const [noticeFresh, setNoticeFresh] = useState(false)
  useEffect(() => {
    if (s.notice === undefined) return
    setNoticeFresh(true)
    const t = setTimeout(() => setNoticeFresh(false), NOTICE_MS)
    return () => clearTimeout(t)
  }, [s.notice])
  const scroller = useRef<Scroller | undefined>(undefined)
  // The grid's shape as last drawn: the keys move by its columns and pages.
  const gridRef = useRef({ gridCols: 2, gridPage: 4 })

  const act = (action: Action | undefined) => {
    if (action === undefined) return
    if (action.type === "answer") props.session.answer(action.answer)
    else if (action.type === "send") props.session.send(action.text)
    else if (action.type === "command") props.session.command(action.text)
    else if (action.type === "stop") props.session.stop()
    else if (action.type === "scroll") scroller.current?.(action.delta)
    else if (action.type === "scroll-talk") talkRef.current?.scrollBy(action.delta)
    // A grant topic's popover answers the topic (older cores' grant prompts answer the prompt).
    else if (action.type === "answer-prompt") void (action.id.startsWith("T-") ? props.session.answerTopic(action.id, action.choice) : props.session.answerPrompt(action.id, action.choice))
    else if (action.type === "close-prompt") void props.session.closePrompt(action.id)
    else if (action.type === "review-acts") for (const a of action.acts) void props.session.act(a.agent, a.action, a.section, a.rows)
    else if (action.type === "archive") void props.session.archive(action.change)
    else if (action.type === "answer-topic") void props.session.answerTopic(action.id, action.answer, action.text)
    else if (action.type === "answer-topics") void props.session.answerTopics(action.ids, action.answer)
    else if (action.type === "snooze-topic") void props.session.snoozeTopic(action.id)
    else if (action.type === "read-topic") void props.session.readTopic(action.id)
    else if (action.type === "reply-topic") void props.session.replyTopic(action.id, action.text)
    else if (action.type === "answer-agent") {
      const agent = action.agent ?? latest().viewing?.split("@")[0]
      if (agent !== undefined) void props.session.answerAgent(agent, action.question, action.answer)
    } else if (action.type === "act") {
      // A panel, a popover or a plugin sheet names its agent; the open view's agent is the one it started with.
      const agent = action.agent ?? latest().viewing?.split("@")[0]
      if (agent !== undefined) void props.session.act(agent, action.action, action.section, action.rows, action.view, action.text)
    } else if (action.type === "exit") props.onExit()
  }

  /** The bar's Enter: the input's own, or the one typed in the burst that opened it. */
  const submit = (value: string) => {
    const r = onSubmit(latest(), props.session.state(), value)
    setUi(r.ui)
    // The input keeps a value of its own: write it too, or a later keystroke brings back what was sent.
    const next = r.draft ?? (r.action !== undefined ? "" : undefined)
    if (next !== undefined) {
      if (inputRef.current !== null) inputRef.current.value = next
      setDraft(next)
    }
    act(r.action)
  }
  useKeyboard((key) => {
    // The bar opened earlier in this same burst (after /) and its input has not rendered yet: the typing is the bar's, never a panel's key.
    const printable = key.sequence !== undefined && key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f" && key.ctrl !== true && key.meta !== true && key.option !== true
    if (barOpening.current && printable) {
      setDraft(draftRef.current + key.sequence)
      return
    }
    if (barOpening.current && key.name === "backspace") {
      setDraft(draftRef.current.slice(0, -1))
      return
    }
    if (barOpening.current && key.name === "return") {
      submit(draftRef.current)
      return
    }
    const before = latest().focus
    const r = onKey(latest(), props.session.state(), { name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta || key.option }, Date.now(), draftRef.current, gridRef.current)
    setUi(r.ui)
    if (before !== "bar" && r.ui.focus === "bar" && r.draft !== undefined) barOpening.current = true
    if (r.draft !== undefined) {
      // Write into the input now, so a key typed right after Tab lands after the completion.
      if (inputRef.current !== null) inputRef.current.value = r.draft
      setDraft(r.draft)
    }
    act(r.action)
  })
  // A paste (a key, a URL) goes into whichever view's input is open; otherwise the focused text field takes it.
  usePaste((e) => {
    const text = new TextDecoder().decode(e.bytes)
    const u = latest()
    for (const k of ["sheetView", "panelView", "view"] as const) {
      const v = u[k]
      const next = v === undefined ? undefined : pasteText(v, text)
      if (next !== undefined) return setUi({ ...u, [k]: next })
    }
  })

  const dims = useTerminalDimensions()
  const narrow = dims.width < 100
  const viewing = ui.viewing
  const inquiry = s.thread.pendingInquiry
  const box = slashActive(ui, s) ? slashBox(draft, ui) : undefined
  const width = Math.max(0, ...(box?.rows ?? []).map((r) => r.label.length))
  // Agents spin only while the clock runs (not while a question waits on you).
  const cursor = railRows(ui, s, undefined, AGENTS_WIDTH - 3).find((a) => a.selected)?.id
  // @scenario S-0073
  // The highlighted agent, while the list has the keys: its task, its turns, its decisions with their confidence.
  const railDetail = ui.focus === "agents" && cursor !== undefined && s.thread.rlms[cursor] !== undefined ? agentDetail(s.thread.rlms, cursor).slice(0, 8) : []
  // Keep the highlighted row on screen as the cursor moves through a tall tree.
  useEffect(() => {
    if (cursor !== undefined) agentsRef.current?.scrollChildIntoView(`agent-${cursor}`)
  }, [cursor])
  // A list whose highlight fills the view: the plugin hears each row the cursor lands on (not the one it opens on).
  const openView = viewing !== undefined ? s.thread.views?.[viewing] : undefined
  const highlighted = openView === undefined ? undefined : JSON.stringify([viewing, highlightActs(openView, ui.view ?? startUi(openView))])
  const lastHighlight = useRef<string | undefined>(undefined)
  useEffect(() => {
    const before = lastHighlight.current
    lastHighlight.current = highlighted
    if (highlighted === undefined || before === undefined || before === highlighted) return
    const [was, prev] = JSON.parse(before) as [string, ReadonlyArray<{ section: string; action: string; rows: ReadonlyArray<string> }>]
    const [now, acts] = JSON.parse(highlighted) as [string, ReadonlyArray<{ section: string; action: string; rows: ReadonlyArray<string> }>]
    if (was !== now || openView === undefined) return
    for (const a of acts) if (!prev.some((p) => p.section === a.section && p.rows[0] === a.rows[0])) act({ type: "act", section: a.section, action: a.action, rows: a.rows, view: openView.agent })
  }, [highlighted])
  const asking = attentionOf(s.thread.rlms)
  const world = { s, now, draft }

  // The rail: agents flat and indented on a raised strip; under 100 columns, only their glyphs until alt+a unfolds it.
  const railWidth = narrow && ui.focus !== "agents" ? 3 : AGENTS_WIDTH
  const rows = railRows(ui, s, moving ? now : undefined, AGENTS_WIDTH - 3)
  const pick = (id: string) => {
    const u = latest()
    const st = props.session.state()
    if (id === ARCHIVED) setUi({ ...u, focus: "agents", agents: { ...u.agents, cursor: ARCHIVED, toggled: { ...u.agents.toggled, [ARCHIVED]: u.agents.toggled[ARCHIVED] !== true } } })
    else if (id.startsWith("archived:")) setUi(openAgent(u, st, id.slice("archived:".length)))
    else if (id.startsWith(NAV)) {
      const r = openNav(u, st, id)
      setUi(r.ui)
      act(r.action)
    }
    else setUi(activate(u, st, id))
  }
  // The rail (Explorer): zarg and where you are, then VIEWS and AGENTS on banded headers; every row one grammar —
  // a gutter bar where you are, a glyph, the name, a note on the right; children on faint tree guides; a hairline edge.
  const wide = railWidth > 3
  const inner = railWidth - 1
  const nav = s.thread.nav ?? []
  const agentCount = rows.filter((r) => !r.id.startsWith("archived:") && r.id !== ARCHIVED).length
  const band = (label: string, count: string, countColor: string) => (
    <text wrapMode="none" bg={C.line}>
      <span fg={C.text}>
        <b>{` ${label}`}</b>
      </span>
      <span>{" ".repeat(Math.max(1, inner - 1 - label.length - count.length - 1))}</span>
      <span fg={countColor}>{`${count} `}</span>
    </text>
  )
  // Gutter, space, guide, glyph, space, name, at least one space, note, space: the name gets what is left.
  const railName = (r: { readonly name: string; readonly note: string; readonly guide: string }) => fit(r.name, Math.max(1, inner - 6 - r.guide.length - r.note.length))
  const inboxOpen = Object.values(s.thread.inbox ?? {}).filter((t) => t.state === "open").length
  const inboxBlocking = Object.values(s.thread.inbox ?? {}).filter((t) => t.state === "open" && t.blocking).length
  const railLine = (r: { readonly glyph: string; readonly glyphColor: string; readonly name: string; readonly note: string; readonly noteColor?: string; readonly guide: string; readonly on: boolean; readonly dimmed: boolean; readonly onPick?: () => void }) => (
    <text
      wrapMode="none"
      {...(r.on ? { bg: C.selection } : {})}
      {...(r.onPick !== undefined
        ? {
            onMouseDown: (e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              dismissMenus()
              r.onPick!()
            },
          }
        : {})}
    >
      <span fg={C.accent}>{r.on ? "▍" : " "}</span>
      {wide ? <span fg={C.faint}>{` ${r.guide}`}</span> : null}
      <span fg={r.glyphColor}>{r.glyph}</span>
      {wide ? <span fg={r.dimmed ? C.dim : C.text}>{r.on ? <b>{` ${railName(r)}`}</b> : ` ${railName(r)}`}</span> : null}
      {wide ? <span>{" ".repeat(Math.max(1, inner - 5 - r.guide.length - railName(r).length - r.note.length))}</span> : null}
      {wide ? <span fg={r.noteColor ?? C.dim}>{`${r.note} `}</span> : null}
    </text>
  )
  /** A child's guide: ├ or └ at its own depth (the last of its siblings in the rows shown gets └). */
  const guideOf = (i: number) => {
    const d = rows[i]!.depth
    if (d === 0) return ""
    let last = true
    for (const r of rows.slice(i + 1)) {
      if (r.depth < d) break
      if (r.depth === d) {
        last = false
        break
      }
    }
    return `${"  ".repeat(d - 1)}${last ? "└ " : "├ "}`
  }
  const agentsList = (
    <box
      // Narrow, the unfolded rail sits over the focus: its click must not reach the focus's handler (which would fold it).
      onMouseDown={(e: { stopPropagation: () => void }) => {
        e.stopPropagation()
        dismissMenus()
        setUi({ ...latest(), focus: "agents" })
      }}
      style={{ ...(narrow && ui.focus === "agents" ? { flexGrow: 1 } : { width: railWidth, flexShrink: 0 }), flexDirection: "column", backgroundColor: C.raised, border: ["right"], borderColor: C.line }}
    >
      {/* zarg, and where you are. */}
      {wide ? (
        <>
          <box style={{ height: 1, flexShrink: 0 }} />
          <text wrapMode="none" style={{ height: 1, flexShrink: 0 }}>
            <span fg={C.accent}>
              <b>{" ◆ zarg"}</b>
            </span>
          </text>
          <text fg={C.dim} wrapMode="none" style={{ height: 1, flexShrink: 0 }}>{fit(`   ${props.meta.repo !== undefined ? `${props.meta.repo} · ` : ""}${props.meta.threadId}`, inner)}</text>
          <box style={{ height: 1, flexShrink: 0 }} />
        </>
      ) : (
        <text fg={C.accent}>{"◆"}</text>
      )}
      {/* VIEWS: the inbox (home), then plugins' views (Journeys, …); a click or Enter opens one. */}
      {wide ? band("VIEWS", String(nav.length + 1), C.dim) : null}
      <box key="inbox" style={{ flexShrink: 0, height: 1 }}>
        {railLine({
          // An unseen blocking topic blinks, as an agent asking for attention does.
          glyph: inboxBlocking > 0 ? (unseenBlocking(ui, s) > 0 && moving && Math.floor(now / PULSE_MS) % 2 === 1 ? "◇" : "◆") : "▤",
          glyphColor: inboxBlocking > 0 ? C.attention : ui.main === "inbox" ? C.accent : C.dim,
          name: "Inbox",
          note: inboxOpen > 0 ? String(inboxOpen) : "",
          guide: "",
          on: (ui.main === "inbox" && ui.focus !== "agents") || (ui.focus === "agents" && ui.agents.cursor === INBOX_ROW),
          dimmed: false,
          onPick: () => setUi({ ...goHome(latest(), props.session.state()), sheet: false, focus: "tile" }),
        })}
      </box>
      {nav.map((n) => {
        const id = `${NAV}${n.id}`
        const on = (ui.agents.cursor === id && ui.focus === "agents") || n.view === viewing
        return (
          <box key={id} style={{ flexShrink: 0, height: 1 }}>
            {railLine({ glyph: "▤", glyphColor: on ? C.accent : C.dim, name: n.label, note: "", guide: "", on, dimmed: false, onPick: () => pick(id) })}
          </box>
        )
      })}
      {/* AGENTS: the tree; ◆ in the header counts those asking. */}
      {wide ? <box style={{ height: 1, flexShrink: 0, ...(nav.length > 0 ? { marginTop: 1 } : {}) }}>{band("AGENTS", asking.length > 0 ? `◆${asking.length}` : String(agentCount), asking.length > 0 ? C.attention : C.dim)}</box> : <text fg={asking.length > 0 ? C.attention : C.dim}>{asking.length > 0 ? "◆" : "·"}</text>}
      {/* Never focusable: the shell's layers alone decide where keys go (a click must not hand a scrollbox the arrows). */}
      <scrollbox ref={agentsRef} focusable={false} style={{ flexGrow: 1 }}>
        {rows.length === 0 && wide ? <text fg={C.dim}>{"  no agents yet"}</text> : null}
        {rows.map((r, i) => {
          const on = (r.selected && ui.focus === "agents") || r.id === viewing
          const guide = guideOf(i)
          const g = r.gauge !== undefined ? gauge(r.gauge.done, r.gauge.total, inner - 4 - guide.length) : undefined
          return (
            <box
              key={r.id}
              id={`agent-${r.id}`}
              style={{ flexDirection: "column", flexShrink: 0, ...(r.id === ARCHIVED ? { marginTop: 1 } : {}) }}
              // The rail's own handler (focus the rail) must not run after the row gave its view the keys.
              onMouseDown={(e: { stopPropagation: () => void }) => {
                e.stopPropagation()
                dismissMenus()
                pick(r.id)
              }}
            >
              {railLine({ glyph: r.glyph, glyphColor: theme.value(r.glyphToken).fg, name: r.name, note: r.note, ...(r.note === "asks" || /found/.test(r.note) ? { noteColor: C.attention } : {}), guide, on, dimmed: r.dimmed })}
              {g !== undefined && wide ? (
                <text wrapMode="none">
                  <span>{`   ${" ".repeat(guide.length)}`}</span>
                  <span fg={C.accent}>{g.done}</span>
                  <span fg={C.faint}>{g.rest}</span>
                </text>
              ) : null}
            </box>
          )
        })}
      </scrollbox>
    </box>
  )

  const busyLine = working(ui, s, now)
  // The focus area's width: right of the rail, less its padding and any right-edge panels.
  // An overlay panel lies over the view: it takes none of its width.
  const rightWidth = panelsShown(ui, s).right.filter((p) => p.overlay !== true).reduce((a, p) => a + p.size + 3, 0)
  const focusWidth = Math.max(10, dims.width - railWidth - 4 - rightWidth)
  // Over another focus the sheet is an inset bottom sheet: a raised block with a half-block lip, rising from the bar, the focus showing around it. As zarg's own focus it fills the area.
  // No box-drawing border: its glyphs sit mid-cell, so a filled border leaves half a cell of fill outside the line.
  const overSheet = ui.sheet && ui.main !== "zarg"
  // zarg's conversation as a sheet over the focus: raised, an accent rule on top, messages, then zarg's question as the picker.
  const LABEL = { you: { text: "you  ", fg: C.dim }, zarg: { text: "zarg  ", fg: C.accent }, error: { text: "!  ", fg: C.error }, notice: { text: "·  ", fg: C.attention } } as const
  const sheet = (
    <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: C.raised }}>
      <box style={{ height: 1, flexShrink: 0, backgroundColor: C.shade, paddingLeft: 2 }}>
        <text wrapMode="none">
          <span fg={ui.focus === "tile" ? C.accent : C.text}>
            <b>zarg</b>
          </span>
          {overSheet ? <span fg={C.dim}>{"   esc closes"}</span> : null}
        </text>
      </box>
      <scrollbox ref={talkRef} focusable={false} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 2, paddingRight: 2 }} stickyScroll stickyStart="bottom">
        {/* @scenario S-0076 */}
        {conversation(s).map((l, i) => l.kind === "zarg" ? (
          <box key={i} flexDirection="row" flexShrink={0}>
            <text width={6} fg={LABEL[l.kind].fg}>{LABEL[l.kind].text}</text>
            <RichText content={l.text} width={focusWidth - 6 - (overSheet ? 6 : 0)} streaming={s.thread.status === "running"} />
          </box>
        ) : (
          <text key={i}>
            <span fg={LABEL[l.kind].fg}>{LABEL[l.kind].text}</span>
            <span fg={l.kind === "error" ? C.error : C.text}>{l.text}</span>
          </text>
        ))}
        {busyLine !== undefined ? <text fg={C.accent}>{busyLine}</text> : null}
      </scrollbox>
      {inquiry !== undefined && ui.chatting !== inquiry.id ? (
        <box style={{ flexDirection: "column", flexShrink: 0, backgroundColor: C.shade, paddingLeft: 2, paddingRight: 2 }}>
          <text fg={C.attention}>
            <b>{inquiry.question}</b>
          </text>
          {pickerRows(inquiry, ui.pick).map((r) => (
            <text key={r.id} wrapMode="none" {...(r.selected ? { bg: C.selection } : {})}>
              <span fg={C.accent}>{r.selected ? "› " : "  "}</span>
              <span fg={r.id === OTHER || r.id === CHAT ? C.dim : C.text}>{r.label}</span>
              {r.recommended ? <span fg={C.dim}>{" (recommended)"}</span> : null}
              {r.selected && r.why !== undefined ? <span fg={C.dim}>{` — ${r.why}`}</span> : null}
              {r.selected && r.id === OTHER ? <span fg={C.dim}>{"  (type it below)"}</span> : null}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  )

  // An open agent's view: a header naming it (no plugin prefix, no view key) and a dim line of how it runs, then its sections.
  const agentId = viewing?.split("@")[0]
  const agentNode = agentId !== undefined ? s.thread.rlms[agentId] : undefined
  const runLine = agentNode === undefined ? [] : agentDetail(s.thread.rlms, agentId).filter((l) => l.startsWith("turn ") || l.startsWith("error "))
  const view =
    viewing === undefined ? null : (
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
        <text wrapMode="none">
          <span fg={C.accent}>
            <b>{fit(agentNode !== undefined ? displayName(agentNode) : ((s.thread.nav ?? []).find((n) => n.view === viewing)?.label ?? agentId ?? ""), focusWidth)}</b>
          </span>
          <span fg={C.dim}>{agentNode !== undefined ? fit(`  ${contextOf(agentNode)}`, Math.max(0, focusWidth - displayName(agentNode).length)) : ""}</span>
        </text>
        {agentNode !== undefined ? <text fg={C.dim} wrapMode="none">{[agentNode.status, ...runLine].filter((x) => x.length > 0).join(" · ")}</text> : null}
        <text> </text>
        {s.thread.views?.[viewing] === undefined ? (
          <text fg={C.dim}>no view yet</text>
        ) : (
          <AgentView
            view={s.thread.views[viewing]!}
            ui={ui.view ?? startUi(s.thread.views[viewing]!)}
            height={Math.max(8, dims.height - 8)}
            width={focusWidth}
            scroller={scroller}
            onPick={(section, i) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), focus: "tile", view: pickRow(v, latest().view ?? startUi(v), section, i) })
            }}
            onAct={(section, action, rows) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v === undefined) return
              // One that asks for text opens its input first; one with choices drops them down.
              const r = pressAction(v, latest().view ?? startUi(v), section, action, rows)
              if (r.act === undefined) return setUi({ ...latest(), focus: "tile", view: r.ui })
              act({ type: "act", ...r.act, view: v.agent })
              setUi({ ...latest(), view: afterAction(r.ui, section) })
            }}
            onClear={(section) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), view: afterAction(latest().view ?? startUi(v), section) })
            }}
            onHeader={(section, col) => {
              keepMenu.current = true
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), focus: "tile", view: pickHeader(v, latest().view ?? startUi(v), section, col) })
            }}
            onSearch={(section, path) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v === undefined) return
              const vu = pickTab(v, latest().view ?? startUi(v), section, latest().view?.tabs[section] ?? 0)
              setUi({ ...latest(), focus: "tile", view: { ...vu, searching: path } })
            }}
            onTab={(section, i) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), focus: "tile", view: pickTab(v, latest().view ?? startUi(v), section, i) })
            }}
            onMark={(section, i) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), focus: "tile", view: pickMark(v, latest().view ?? startUi(v), section, i) })
            }}
            onMenuAdjust={(i, dir) => {
              keepMenu.current = true
              const v = props.session.state().thread.views?.[viewing]
              if (v === undefined) return
              const vu = latest().view ?? startUi(v)
              setUi({ ...latest(), focus: "tile", view: menuAdjust(v, vu.menu === undefined ? vu : { ...vu, menu: { ...vu.menu, pick: i } }, dir) })
            }}
            onChoose={(i) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v === undefined) return
              const r = pickChoice(latest().view ?? startUi(v), i)
              setUi({ ...latest(), focus: "tile", view: r.ui })
              if (r.act !== undefined) act({ type: "act", ...r.act, view: v.agent })
            }}
            onBoardPick={(path, lane, card) => {
              const v = props.session.state().thread.views?.[viewing]
              if (v === undefined) return
              const r = pickCard(v, latest().view ?? startUi(v), path, lane, card)
              setUi({ ...latest(), focus: "tile", view: r.ui })
              if (r.act !== undefined) act({ type: "act", ...r.act, view: v.agent })
            }}
            onMenuPick={(i) => {
              keepMenu.current = true
              const v = props.session.state().thread.views?.[viewing]
              if (v !== undefined) setUi({ ...latest(), focus: "tile", view: applyMenu(v, latest().view ?? startUi(v), i) })
            }}
          />
        )}
      </box>
    )

  const chatting = inquiry !== undefined && ui.chatting === inquiry.id
  const label = answeringOther(ui, s) ? "answer ›" : chatting ? "chat ›" : "message ›"
  const line = barLine(ui, s, now)
  // The bar: one raised line — the typing, zarg's question, its latest reply, or the prompt.
  const bar = (
    <box onMouseDown={() => setUi(focusBar(latest(), props.session.state()))} style={{ height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: C.raised, paddingLeft: 1 }}>
      {typing(ui, s) ? (
        <>
          <text fg={C.accent} wrapMode="none">{label === "message ›" ? "› " : `${label} `}</text>
          <input
            ref={inputRef}
            focused={inputFocused(ui, s)}
            value={draft}
            placeholder={answeringOther(ui, s) ? "your own answer, Enter to send" : chatting ? "ask about the question; Esc goes back to the options" : "type a message, Enter to send"}
            style={{ flexGrow: 1, backgroundColor: C.raised, focusedBackgroundColor: C.raised, textColor: C.text, focusedTextColor: C.text, placeholderColor: C.faint }}
            onInput={(text: string) => {
              setDraft(text)
              // Typing picks the box afresh: no highlighted row.
              const u = latest()
              if (u.slash?.sel !== null && u.slash?.sel !== undefined) setUi({ ...u, slash: { sel: null, cycle: u.slash.cycle } })
            }}
            // The input passes its value; the prop's type also admits DOM's SubmitEvent, hence `unknown`.
            onSubmit={(value: unknown) => submit(String(value))}
          />
        </>
      ) : line.tone === "question" && line.text.startsWith("◆ zarg asks ") ? (
        <text wrapMode="none">
          <span fg={C.attention}>{"◆ zarg asks "}</span>
          <span fg={C.text}>{fit(inquiry?.question ?? "", Math.max(8, dims.width - railWidth - 1 - "◆ zarg asks ".length - "   ⏎ answer   / chat".length))}</span>
          <span fg={C.dim}>{"   ⏎ answer   / chat"}</span>
        </text>
      ) : (
        <text wrapMode="none" fg={line.tone === "working" ? C.accent : line.tone === "question" ? C.attention : line.tone === "idle" && line.text.startsWith("›") ? C.faint : C.dim}>
          {line.text}
        </text>
      )}
    </box>
  )

  const slash =
    box === undefined ? null : (
      <box style={{ flexDirection: "column", flexShrink: 0, backgroundColor: C.raised, paddingLeft: 1 }}>
        <text fg={C.dim} wrapMode="none">{box.title}</text>
        {box.rows.map((r) => (
          <text key={r.label} wrapMode="none" {...(r.selected ? { bg: C.selection } : {})}>
            <span fg={C.accent}>{r.selected ? "› " : "  "}</span>
            <span fg={C.text}>{r.label.padEnd(width)}</span>
            <span fg={C.dim}>{`  ${r.desc}`}</span>
          </text>
        ))}
        {box.hint !== undefined ? <text fg={C.dim}>{`  ${box.hint}`}</text> : null}
        {box.lint !== undefined ? <text fg={C.error}>{`✗ ${box.lint}`}</text> : null}
      </box>
    )


  const queue = queueOf(ui, s)
  const head = queue[0]
  const popWidth = Math.min(60, dims.width - 4)
  const headView = head?.kind === "surface" && head.view !== undefined ? s.thread.views?.[head.view] : undefined
  const popover =
    head === undefined ? null : head.kind === "surface" ? (
      // A plugin's popover: its view, over everything; Esc closes it.
      <box
        style={{ position: "absolute", left: Math.max(0, Math.floor((dims.width - popWidth) / 2)), top: 3, width: popWidth, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.accent, backgroundColor: C.raised, paddingLeft: 1, paddingRight: 1 }}
      >
        <text wrapMode="none">
          <span fg={C.accent}>
            <b>{fit(head.question, Math.max(8, popWidth - 4 - (queue.length > 1 ? `  1 of ${queue.length}`.length : 0)))}</b>
          </span>
          <span fg={C.dim}>{queue.length > 1 ? `  1 of ${queue.length}` : ""}</span>
        </text>
        {headView === undefined ? <text fg={C.dim}>no view yet</text> : <AgentView view={headView} ui={ui.popover.view ?? startUi(headView)} height={Math.max(6, Math.floor(dims.height / 2))} width={popWidth - 2} />}
      </box>
    ) : (
      <box
        style={{ position: "absolute", left: Math.max(0, Math.floor((dims.width - popWidth) / 2)), top: 3, width: popWidth, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.attention, backgroundColor: C.raised, paddingLeft: 1, paddingRight: 1 }}
      >
        <text wrapMode="none">
          <span fg={C.attention}>
            <b>grant</b>
          </span>
          <span fg={C.dim}>{queue.length > 1 ? `  1 of ${queue.length} · next: ${fit(queue[1]!.question, 30)}` : ""}</span>
        </text>
        <text fg={C.text}>{head.question}</text>
        <text> </text>
        <box style={{ flexDirection: "row", height: 1 }}>
          {head.options.map((o, i) => {
            const on = i === Math.min(ui.popover.pick, head.options.length - 1)
            return (
              <text key={o.id} fg={on ? C.text : C.dim} onMouseDown={() => act({ type: "answer-prompt", id: head.id, choice: o.id })} {...(on ? { bg: C.selection } : {})}>
                {`${on ? "› " : "  "}${o.label}   `}
              </text>
            )
          })}
        </box>
      </box>
    )

  // Panels at the tile area's edges: a header with its name and a × that closes it, then its view.
  const shown = panelsShown(ui, s)
  const panelBox = (p: Panel) => {
    const v = s.thread.views?.[p.view]
    const focusedHere = ui.focus === "panel" && ui.panel === p.id
    // A right panel runs the tile's height (a drawer grows to fill its overlay; a side panel stretches in its row); top and bottom ones their size in rows.
    const size = p.edge === "right" ? { width: p.size + 3, flexShrink: 0, ...(p.overlay === true ? { flexGrow: 1 } : {}) } : { height: p.size + 1, flexShrink: 0 }
    return (
      <box
        key={p.id}
        onMouseDown={(e: { stopPropagation: () => void }) => {
          e.stopPropagation()
          dismissMenus()
          if (p.input === "onFocus") setUi({ ...latest(), focus: "panel", panel: p.id })
        }}
        style={{ ...size, flexDirection: "column", paddingLeft: 2, paddingRight: 1 }}
      >
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          {/* A drawer needs no name: its × alone, at the right. */}
          {p.overlay === true ? <box style={{ flexGrow: 1 }} /> : (
            <text fg={focusedHere ? C.accent : C.dim} wrapMode="none">
              <b>{`${p.name} `}</b>
            </text>
          )}
          <text
            fg={C.faint}
            onMouseDown={(e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              dismissMenus()
              const u = latest()
              setUi({ ...u, closedPanels: [...u.closedPanels, closedKey(p)], ...(u.panel === p.id ? { focus: "tile" as const } : {}) })
            }}
          >
            ×
          </text>
        </box>
        {v === undefined ? null : (
          <AgentView
            view={v}
            ui={focusedHere ? (ui.panelView ?? startUi(v)) : startUi(v)}
            // A right panel runs the tile area's height; its size is its width.
            height={p.edge === "right" ? Math.max(4, areaHeight - 2) : p.size}
            width={p.edge === "right" ? p.size : dims.width - railWidth - 4}
            // A panel's buttons act for its plugin's agent (a drawer's Ready, Drop, …).
            onAct={(section, action, rows) => {
              const owner = { agent: v.agent.split("@")[0]!, view: v.agent }
              const r = pressAction(v, latest().panelView ?? startUi(v), section, action, rows)
              if (r.act === undefined) return setUi({ ...latest(), focus: "panel", panel: p.id, panelView: r.ui })
              act({ type: "act", ...r.act, ...owner })
            }}
            onChoose={(i) => {
              const r = pickChoice(latest().panelView ?? startUi(v), i)
              setUi({ ...latest(), focus: "panel", panel: p.id, panelView: r.ui })
              if (r.act !== undefined) act({ type: "act", ...r.act, agent: v.agent.split("@")[0]!, view: v.agent })
            }}
          />
        )}
      </box>
    )
  }
  // A plugin's sheet over the tile area: its view, rounded like zarg's.
  const sheetViewState = ui.sheetOf !== undefined ? s.thread.views?.[ui.sheetOf] : undefined
  const pluginSheet = (
    <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: C.raised }}>
      <box style={{ height: 1, flexShrink: 0, backgroundColor: C.shade, paddingLeft: 2 }}>
        <text wrapMode="none">
          <span fg={ui.focus === "tile" ? C.accent : C.text}>
            <b>{sheetViewState?.layout.name ?? "sheet"}</b>
          </span>
          <span fg={C.dim}>{fit(`  ${(() => { const n = s.thread.rlms[(ui.sheetOf ?? "").split("@")[0]!]; return n !== undefined ? displayName(n) : "" })()}   esc closes`, Math.max(0, focusWidth - 4 - (sheetViewState?.layout.name ?? "sheet").length))}</span>
        </text>
      </box>
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
        {sheetViewState === undefined ? <text fg={C.dim}>no view yet</text> : <AgentView
            view={sheetViewState}
            ui={ui.sheetView ?? startUi(sheetViewState)}
            height={Math.max(6, dims.height - 8)}
            width={focusWidth}
            onAct={(section, action, rows) => {
              const r = pressAction(sheetViewState, latest().sheetView ?? startUi(sheetViewState), section, action, rows)
              if (r.act === undefined) return setUi({ ...latest(), sheetView: r.ui })
              act({ type: "act", ...r.act, agent: sheetViewState.agent.split("@")[0]!, view: sheetViewState.agent })
              setUi({ ...latest(), sheetView: afterAction(r.ui, section) })
            }}
            onClear={(section) => setUi({ ...latest(), sheetView: afterAction(latest().sheetView ?? startUi(sheetViewState), section) })}
          />}
      </box>
    </box>
  )

  // The grid: agents as cards, paginated; the cursor's card in the accent colour; a click or ⏎ opens it.
  const areaHeight = Math.max(6, dims.height - 2 - shown.bottom.reduce((a, p) => a + p.size + 1, 0))
  const shape = gridShape(focusWidth, areaHeight - 1, narrow)
  const perPage = shape.cols * shape.rows
  gridRef.current = { gridCols: shape.cols, gridPage: perPage }
  const cards = gridCards(ui, s)
  const cursorAt = gridCursor(ui, cards)
  const page = Math.floor(cursorAt / perPage)
  const pages = Math.max(1, Math.ceil(cards.length / perPage))
  const cardW = Math.max(12, Math.floor(focusWidth / shape.cols) - 4)
  const cardH = Math.floor((areaHeight - 1) / shape.rows)
  const cardBox = (c: Card, i: number) => {
    const on = page * perPage + i === cursorAt
    const g = c.gauge !== undefined ? gauge(c.gauge.done, c.gauge.total, Math.max(4, cardW - 10)) : undefined
    return (
      <box
        key={c.id}
        onMouseDown={(e: { stopPropagation: () => void }) => {
          e.stopPropagation()
          dismissMenus()
          setUi(openAgent(latest(), props.session.state(), c.id))
        }}
        style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: on && ui.focus === "tile" ? C.accent : C.line, paddingLeft: 1, paddingRight: 1 }}
      >
        <text wrapMode="none">
          <span fg={theme.value(c.glyphToken).fg}>{`${c.glyph} `}</span>
          <span fg={C.text}>
            <b>{fit(c.name, cardW - 2)}</b>
          </span>
          <span fg={C.dim}>{fit(`  ${c.context}`, Math.max(0, cardW - 2 - c.name.length))}</span>
        </text>
        {g !== undefined ? (
          <text wrapMode="none">
            <span fg={c.attention ? C.attention : C.accent}>{g.done}</span>
            <span fg={C.faint}>{g.rest}</span>
            <span fg={C.dim}>{`  ${c.gauge!.done}/${c.gauge!.total}`}</span>
          </text>
        ) : null}
        <text wrapMode="none" fg={c.starting && c.headline === undefined ? C.dim : c.attention ? C.attention : C.text}>
          {fit(c.headline ?? (c.starting ? "starting…" : ""), cardW)}
        </text>
        {/* Short cards (a narrow terminal) keep the headline and gauge; roomy ones add recent lines. */}
        {!narrow && cardH >= 8
          ? c.recent.map((r, n) => (
              <text key={n} wrapMode="none" fg={C.dim}>
                {fit(r.text, cardW)}
              </text>
            ))
          : null}
        <box style={{ flexGrow: 1 }} />
        {c.action !== undefined ? <text fg={C.faint} wrapMode="none">{`${c.action.key} ${c.action.label}`}</text> : null}
      </box>
    )
  }
  const shownCards = cards.slice(page * perPage, page * perPage + perPage)
  const grid = (
    <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
      <text wrapMode="none">
        <span fg={ui.focus === "tile" ? C.accent : C.dim}>
          <b> all agents</b>
        </span>
        <span fg={C.dim}>{pages > 1 ? `   page ${page + 1} of ${pages}   ` : "   "}</span>
        <span fg={C.faint}>{pages > 1 ? Array.from({ length: pages }, (_, i) => (i === page ? "●" : "○")).join("") : ""}</span>
      </text>
      {cards.length === 0 ? (
        <text fg={C.dim}>{"   no agents yet · / to start one with zarg"}</text>
      ) : (
        Array.from({ length: shape.rows }, (_, r) => shownCards.slice(r * shape.cols, r * shape.cols + shape.cols)).filter((row) => row.length > 0).map((row, r) => (
          <box key={r} style={{ height: cardH, flexShrink: 0, flexDirection: "row" }}>
            {row.map((c, i) => cardBox(c, r * shape.cols + i))}
            {Array.from({ length: shape.cols - row.length }, (_, i) => (
              <box key={`gap-${i}`} style={{ flexGrow: 1, flexBasis: 0 }} />
            ))}
          </box>
        ))
      )}
    </box>
  )

  // The review queue: every review table of every agent, one heading per table, ○/● selection, the cursor row.
  const groups = reviewGroups(s)
  const reviewRows = groups.flatMap((g) => g.rows)
  const reviewAt = Math.min(ui.review.cursor, Math.max(0, reviewRows.length - 1))
  const reviewKey = reviewRows[reviewAt]?.key
  // The review queue's cursor row stays on screen as it moves.
  useEffect(() => {
    if (reviewKey === undefined) return
    const t = setTimeout(() => reviewRef.current?.scrollChildIntoView(`review-${reviewKey}`), 0)
    return () => clearTimeout(t)
  }, [reviewKey])
  // Its buttons: the selection actions of the tables the selected rows are in, once each.
  const reviewPicked = ui.review.selected.filter((k) => reviewRows.some((r) => r.key === k))
  // Always there (the status line carries no view keys): every table's actions, once each; they take the ticked rows, else the highlighted one.
  const reviewButtons = [...new Map(groups.flatMap((g) => g.actions).map((a) => [a.id, a] as const)).values()]
  const review = (
    <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
      <text wrapMode="none">
        <span fg={ui.focus === "tile" ? C.accent : C.dim}>
          <b>review</b>
        </span>
        <span fg={C.dim}>{`   ${reviewRows.length} open · ${new Set(groups.map((g) => g.agent)).size} agents`}</span>
      </text>
      <text> </text>
      {groups.length === 0 ? <text fg={C.dim}>nothing to review</text> : null}
      <scrollbox ref={reviewRef} focusable={false} style={{ flexGrow: 1 }}>
        {groups.map((g) => (
          <box key={`${g.agent}|${g.section}`} style={{ flexDirection: "column", flexShrink: 0 }}>
            <Heading title={g.name} width={focusWidth} focused={false} />
            {g.rows.map((r) => {
              const on = reviewRows[reviewAt]?.key === r.key
              const picked = ui.review.selected.includes(r.key)
              return (
                <text key={r.key} id={`review-${r.key}`} wrapMode="none" {...(on ? { bg: C.selection } : {})}>
                  <span fg={C.accent}>{on ? "▍" : " "}</span>
                  <span fg={picked ? C.accent : C.dim}>{picked ? "● " : "○ "}</span>
                  <span fg={picked || on ? C.text : toneFg(theme, r.row.tone)}>{fit(g.columns.map((c) => r.row.cells[c.id] ?? "").join("  "), focusWidth - 4)}</span>
                </text>
              )
            })}
            <text> </text>
          </box>
        ))}
      </scrollbox>
      {reviewRows.length > 0 && reviewButtons.length > 0 ? (
        <box style={{ flexShrink: 0, marginTop: 1, paddingLeft: 1 }}>
          <Buttons
            actions={reviewButtons}
            count={reviewPicked.length}
            onPress={(id) => {
              const key = keyFor(reviewButtons.find((a) => a.id === id)!, "terminal")
              const acts = key === undefined ? [] : reviewActs(groups, reviewAt, reviewPicked, key)
              if (acts.length > 0) act({ type: "review-acts", acts })
              setUi({ ...latest(), review: { ...latest().review, selected: [] } })
            }}
            {...(reviewPicked.length > 0 ? { onClear: () => setUi({ ...latest(), review: { ...latest().review, selected: [] } }) } : {})}
          />
        </box>
      ) : null}
    </box>
  )

  // The inbox (home): every topic that wants the operator, most urgent first; Enter opens one, its answers as buttons.
  const topics = inboxRows(ui, s)
  const inboxAt = inboxCursor(ui, topics)
  const ago = (at: number) => {
    const m = Math.max(0, Math.floor((Date.now() - at) / 60_000))
    return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
  }
  const topicGlyph = (t: Topic) =>
    t.state === "answered" ? { g: "✓", c: C.dim } : t.state !== "open" ? { g: "–", c: C.dim } : t.blocking ? { g: "◆", c: C.attention } : (t.answers ?? []).length > 0 ? { g: "◇", c: C.accent } : { g: "·", c: C.dim }
  const topicHint = (t: Topic) =>
    [t.kind, ...(t.blocking && t.state === "open" ? ["waiting"] : []), ...((t.answers ?? []).length > 1 ? [`${t.answers!.length} options`] : []), ...(t.messages.length > 0 ? [`${t.messages.length} ${t.messages.length === 1 ? "reply" : "replies"}`] : [])].join(" · ")
  const openTopic = ui.inbox.open === undefined ? undefined : s.thread.inbox?.[ui.inbox.open]
  const inbox =
    openTopic !== undefined ? (
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
        {/* The header keeps its lines however long the evidence below (a column shrinks its children otherwise). */}
        <text wrapMode="none" style={{ flexShrink: 0 }}>
          <span fg={C.dim}>{"← Inbox   "}</span>
          <span fg={C.text}>
            <b>{fit(openTopic.title.split("\n")[0] ?? "", focusWidth - 14)}</b>
          </span>
        </text>
        <text fg={C.dim} wrapMode="none" style={{ flexShrink: 0 }}>{fit([openTopic.from.agent ?? openTopic.from.plugin, openTopic.kind, openTopic.why === openTopic.kind ? "" : openTopic.why, ago(openTopic.created)].filter((x) => x !== "").join(" · "), focusWidth - 4)}</text>
        <text style={{ flexShrink: 0 }}> </text>
        <scrollbox focusable={false} style={{ flexGrow: 1 }}>
          {/* A title longer than its header line (zarg's proposal holds the whole change) is shown whole: nothing is approved unseen. */}
          {openTopic.title.includes("\n") || openTopic.title.length > focusWidth - 14 ? <RichText content={openTopic.title} width={focusWidth - 6} /> : null}
          {openTopic.evidence !== undefined ? <RichText content={openTopic.evidence} width={focusWidth - 6} /> : null}
          {openTopic.messages.map((m, i) => (
            <box key={`m${i}`} style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
              <text fg={C.dim} wrapMode="none">{`${m.by} · ${ago(m.at)}`}</text>
              <RichText content={m.text} width={focusWidth - 8} />
            </box>
          ))}
          {openTopic.state !== "open" ? <text fg={C.dim}>{openTopic.state === "moot" ? `It stopped mattering: ${openTopic.moot ?? ""}` : openTopic.state === "read" ? "Read." : `Answered: ${openTopic.answers?.find((a) => a.id === openTopic.answer?.id)?.label ?? openTopic.answer?.id ?? ""}${openTopic.answer?.text !== undefined ? ` (${openTopic.answer.text})` : ""}`}</text> : null}
        </scrollbox>
        {openTopic.state === "open" && (openTopic.answers ?? []).length > 0 ? (
          <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
            {openTopic.answers!.map((a, i) => {
              const on = (ui.inbox.pick ?? 0) === i
              return (
                <text key={a.id} {...(on ? { bg: C.selection } : {})} onMouseDown={() => act({ type: "answer-topic", id: openTopic.id, answer: a.id })}>
                  <span fg={C.accent}>{on ? "▍" : " "}</span>
                  <span fg={C.accent}>{`${i + 1}  `}</span>
                  <span fg={C.text}>{a.label}</span>
                  <span fg={C.dim}>{`${a.recommended === true ? "  (recommended)" : ""}${a.why !== undefined ? `  ${a.why}` : ""}`}</span>
                </text>
              )
            })}
          </box>
        ) : null}
        {ui.inbox.typing !== undefined ? (
          <text wrapMode="none" style={{ marginTop: 1 }}>
            <span fg={C.accent}>{"› "}</span>
            <span fg={C.text}>{ui.inbox.typing.text}</span>
            <span fg={C.dim}>{ui.inbox.typing.text === "" ? `${ui.inbox.typing.reply === true ? "your reply" : (openTopic.text?.placeholder ?? "the reason")}, Enter to send` : "▏"}</span>
          </text>
        ) : null}
      </box>
    ) : (
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
        <text wrapMode="none" style={{ flexShrink: 0 }}>
          <span fg={ui.focus === "tile" ? C.accent : C.dim}>
            <b>inbox</b>
          </span>
          <span fg={C.dim}>{`   ${topics.length} ${ui.inbox.all ? "topics" : "open"}${ui.inbox.marked.length > 0 ? ` · ${ui.inbox.marked.length} marked` : ""}`}</span>
        </text>
        <text> </text>
        {topics.length === 0 ? <text fg={C.dim}>Nothing needs you.</text> : null}
        <scrollbox focusable={false} style={{ flexGrow: 1 }}>
          {topics.map((t, i) => {
            const on = i === inboxAt
            const g = topicGlyph(t)
            const marked = ui.inbox.marked.includes(t.id)
            const who = t.from.agent ?? t.from.plugin
            const hint = topicHint(t)
            const age = ago(t.created)
            return (
              <text key={t.id} wrapMode="none" {...(on ? { bg: C.selection } : {})} onMouseDown={() => {
                  const r = openTopicUi({ ...latest(), inbox: { ...latest().inbox, cursor: i } }, t)
                  setUi(r.ui)
                  act(r.action)
                }}>
                <span fg={C.accent}>{on ? "▍" : " "}</span>
                <span fg={marked ? C.accent : g.c}>{marked ? "● " : `${g.g} `}</span>
                <span fg={C.dim}>{`${fit(who, 12).padEnd(12)}  `}</span>
                <span fg={on ? C.text : t.state === "open" ? C.text : C.dim}>{fit(t.title, Math.max(10, focusWidth - 24 - hint.length - age.length))}</span>
                <span fg={C.dim}>{`  ${hint}  ${age}`}</span>
              </text>
            )
          })}
        </scrollbox>
      </box>
    )

  // ^k: a rounded box over everything: the query, then what it finds.
  const found = ui.palette === undefined ? [] : paletteEntries(s, ui.palette.query, SLASH_COMMANDS)
  const palWidth = Math.min(60, dims.width - 4)
  const palette =
    ui.palette === undefined ? null : (
      <box style={{ position: "absolute", left: Math.max(0, Math.floor((dims.width - palWidth) / 2)), top: 3, width: palWidth, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: C.accent, backgroundColor: C.raised, paddingLeft: 1, paddingRight: 1 }}>
        <text wrapMode="none">
          <span fg={C.accent}>{"› "}</span>
          <span fg={C.text}>{ui.palette.query}</span>
          <span fg={C.accent}>▎</span>
        </text>
        <text fg={C.faint} wrapMode="none">{"─".repeat(Math.max(0, palWidth - 4))}</text>
        {found.length === 0 ? <text fg={C.dim}>nothing matches</text> : null}
        {found.slice(0, 10).map((e, i) => (
          <text key={e.id} wrapMode="none" {...(i === Math.min(ui.palette!.pick, found.length - 1) ? { bg: C.selection } : {})}>
            <span fg={C.dim}>{`${e.glyph} `}</span>
            <span fg={C.text}>{fit(e.label, 24).padEnd(24)}</span>
            <span fg={C.dim}>{fit(`  ${e.detail}`, palWidth - 30)}</span>
          </text>
        ))}
      </box>
    )

  // The status line: where things stand, then the keys of what has focus (glyphs, three spaces apart).
  const hints = hintsOf(SHELL, ui, world)
    .map((h) => `${keyGlyphs(h.keys)} ${h.does}`)
    .join("   ")
  const firstAsking = attentionOf(s.thread.rlms)[0]
  const askingNode = firstAsking === undefined ? undefined : s.thread.rlms[firstAsking.id]
  // Who asks first (it must survive a narrow line), then where things stand.
  const status = ` ${[...(askingNode !== undefined ? [`◆ ${displayName(askingNode)} ${firstAsking!.reason}`] : []), statusLine(s, props.meta), ...(s.notice !== undefined && !noticeFresh ? [s.notice] : [])].join("   ")}`

  return (
    <ThemeContext.Provider value={theme}>
    <NowContext.Provider value={now}>
    <box
      onMouseDown={() => {
        dismissMenus()
        // A click outside a drawer closes it (a click in it stops at its box).
        const u = latest()
        const closed = closeOverlays(u, props.session.state())
        if (closed !== u) setUi(closed)
      }}
      style={{ flexDirection: "row", width: "100%", height: "100%", backgroundColor: C.bg }}
    >
      {narrow && ui.focus === "agents" ? null : agentsList}
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        <box onMouseDown={() => setUi({ ...latest(), focus: "tile" })} style={{ flexGrow: 1, flexDirection: "column" }}>
          {shown.top.map(panelBox)}
          <box style={{ flexGrow: 1, flexDirection: "row" }}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              {narrow && ui.focus === "agents" ? agentsList : ui.main === "zarg" ? sheet : ui.main === "grid" ? grid : ui.main === "review" ? review : ui.main === "inbox" ? inbox : view}
              {!(narrow && ui.focus === "agents") && overSheet ? (
                <box style={{ position: "absolute", left: 3, right: 3, bottom: 0, height: Math.max(8, Math.floor(areaHeight * 0.65)), flexDirection: "column" }}>
                  <text fg={C.shade} bg={C.bg} wrapMode="none" style={{ flexShrink: 0 }}>
                    {"▄".repeat(Math.max(0, focusWidth - 2))}
                  </text>
                  {ui.sheetOf !== undefined ? pluginSheet : sheet}
                </box>
              ) : null}
              {/* A drawer: over the right of the view, which keeps its width. */}
              {shown.right.filter((p) => p.overlay === true).map((p) => (
                <box key={`over-${p.id}`} style={{ position: "absolute", right: 0, top: 0, bottom: 0, zIndex: 20, backgroundColor: C.raised, border: ["left"], borderColor: C.accent }}>
                  {/* However wide it asks to be, a strip of the view stays in sight. */}
                  {panelBox({ ...p, size: Math.max(20, Math.min(p.size, focusWidth - 12)) })}
                </box>
              ))}
            </box>
            {shown.right.filter((p) => p.overlay !== true).map(panelBox)}
          </box>
          {shown.bottom.map(panelBox)}
        </box>
        {railDetail.length > 0 ? (
          <box style={{ flexShrink: 0, flexDirection: "column", paddingLeft: 1 }}>
            {railDetail.map((l, i) => (
              <text key={i} wrapMode="none" fg={i === 0 ? C.text : C.dim}>{fit(l, Math.max(10, dims.width - railWidth - 3))}</text>
            ))}
          </box>
        ) : null}
        {/* Above the bar: the bar stays where it was. */}
        {/* A command's outcome (why reconcile stays off): whole, on its own line, until the next one. */}
        {s.notice !== undefined && noticeFresh ? (
          <box style={{ flexShrink: 0, paddingLeft: 1, width: Math.max(10, dims.width - railWidth - 1) }}>
            <text fg={C.attention}>{`· ${s.notice}`}</text>
          </box>
        ) : null}
        {slash}
        {bar}
        <box style={{ height: 1, flexShrink: 0 }}>
          <text wrapMode="none">
            {/* The keys come first: the status gives way on a narrow screen. */}
            <span fg={C.dim}>{fit(status, Math.max(0, dims.width - railWidth - hints.length - 3))}</span>
            <span fg={C.dim}>{`   ${hints}`}</span>
          </text>
        </box>
      </box>
      {popover}
      {palette}
    </box>
    </NowContext.Provider>
    </ThemeContext.Provider>
  )
}
