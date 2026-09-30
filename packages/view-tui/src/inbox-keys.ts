import { openTopics, type SessionState, sortTopics, type Topic } from "@zarg/client"
import type { Action, Ui } from "./view"

type Key = { readonly name: string; readonly sequence?: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean }
type Out = { readonly ui: Ui; readonly action?: Action }

/** The inbox's rows: open topics, most urgent first (`a`: every topic, answered and moot ones too). */
export const inboxRows = (ui: Ui, s: SessionState): ReadonlyArray<Topic> =>
  ui.inbox.all ? sortTopics(Object.values(s.thread.inbox ?? {}), Date.now()) : openTopics(s.thread)

type Patch = { readonly [K in keyof Ui["inbox"]]?: Ui["inbox"][K] | undefined }
/** The inbox state with a patch; an undefined field is removed (the open topic closed, the reason dropped). */
const withInbox = (ui: Ui, patch: Patch): Ui => {
  const next: Record<string, unknown> = { ...ui.inbox, ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  return { ...ui, inbox: next as Ui["inbox"] }
}
const digit = (k: Key) => (/^[1-9]$/.test(k.name) ? Number(k.name) - 1 : undefined)
const answersOf = (t: Topic | undefined) => t?.answers ?? []
/** Opening a topic: a report (nothing to answer) is read by being opened. */
const open = (ui: Ui, t: Topic): Out => ({
  ui: withInbox(ui, { open: t.id, pick: Math.max(0, answersOf(t).findIndex((a) => a.recommended === true)) }),
  ...(t.state === "open" && !t.blocking && answersOf(t).length === 0 ? { action: { type: "read-topic" as const, id: t.id } } : {}),
})

/** A key in the inbox: the list (move, open, mark, batch, snooze) or the open topic (answer, reason, snooze, back). */
export const inboxKey = (ui: Ui, s: SessionState, k: Key): Out => {
  const rows = inboxRows(ui, s)
  const typing = ui.inbox.typing
  // A reason being typed: printable keys, Backspace, Enter sends it with the highlighted answer, Esc drops it.
  if (typing !== undefined) {
    const t = s.thread.inbox?.[typing.id]
    if (k.name === "escape") return { ui: withInbox(ui, { typing: undefined }) }
    if (k.name === "backspace") return { ui: withInbox(ui, { typing: { ...typing, text: typing.text.slice(0, -1) } }) }
    if (k.name === "return") {
      const answer = answersOf(t)[ui.inbox.pick ?? 0]?.id
      return { ui: withInbox(ui, { typing: undefined }), action: { type: "answer-topic", id: typing.id, ...(answer !== undefined ? { answer } : {}), text: typing.text } }
    }
    const ch = k.name === "space" ? " " : k.name.length === 1 ? (k.shift === true ? k.name.toUpperCase() : k.name) : (k.sequence ?? "")
    return ch.length === 1 && k.ctrl !== true && k.meta !== true ? { ui: withInbox(ui, { typing: { ...typing, text: typing.text + ch } }) } : { ui }
  }
  const openId = ui.inbox.open
  if (openId !== undefined) {
    const t = s.thread.inbox?.[openId]
    const n = digit(k)
    if (k.name === "escape") return { ui: withInbox(ui, { open: undefined, pick: undefined }) }
    if (n !== undefined && answersOf(t)[n] !== undefined) return { ui: withInbox(ui, { open: undefined }), action: { type: "answer-topic", id: openId, answer: answersOf(t)[n]!.id } }
    if (k.name === "up" || k.name === "down") {
      const count = answersOf(t).length
      return count === 0 ? { ui } : { ui: withInbox(ui, { pick: Math.max(0, Math.min(count - 1, (ui.inbox.pick ?? 0) + (k.name === "up" ? -1 : 1))) }) }
    }
    if (k.name === "return" && answersOf(t)[ui.inbox.pick ?? 0] !== undefined) return { ui: withInbox(ui, { open: undefined }), action: { type: "answer-topic", id: openId, answer: answersOf(t)[ui.inbox.pick ?? 0]!.id } }
    if (k.name === "t" && t?.state === "open" && (answersOf(t).length > 0 || t.text !== undefined)) return { ui: withInbox(ui, { typing: { id: openId, text: "" } }) }
    if (k.name === "z") return { ui, action: { type: "snooze-topic", id: openId } }
    return { ui }
  }
  const at = Math.min(ui.inbox.cursor, Math.max(0, rows.length - 1))
  const here = rows[at]
  const n = digit(k)
  if (k.name === "up" || k.name === "down") return { ui: withInbox(ui, { cursor: Math.max(0, Math.min(rows.length - 1, at + (k.name === "up" ? -1 : 1))) }) }
  if (k.name === "a") return { ui: withInbox(ui, { all: !ui.inbox.all, cursor: 0 }) }
  if (k.name === "escape" && ui.inbox.marked.length > 0) return { ui: withInbox(ui, { marked: [] }) }
  if (here === undefined) return { ui }
  if (k.name === "return") return open(ui, here)
  if (k.name === "space") {
    const marked = ui.inbox.marked
    if (marked.includes(here.id)) return { ui: withInbox(ui, { marked: marked.filter((m) => m !== here.id) }) }
    // A batch is one kind of topic, all open.
    const kind = s.thread.inbox?.[marked[0] ?? ""]?.kind
    return here.state !== "open" || (kind !== undefined && kind !== here.kind) ? { ui } : { ui: withInbox(ui, { marked: [...marked, here.id] }) }
  }
  if (n !== undefined && ui.inbox.marked.length > 0) {
    const answer = answersOf(s.thread.inbox?.[ui.inbox.marked[0]!])[n]?.id
    return answer === undefined ? { ui } : { ui: withInbox(ui, { marked: [] }), action: { type: "answer-topics", ids: ui.inbox.marked, answer } }
  }
  if (n !== undefined && answersOf(here)[n] !== undefined) return { ui, action: { type: "answer-topic", id: here.id, answer: answersOf(here)[n]!.id } }
  if (k.name === "z") return { ui, action: { type: "snooze-topic", id: here.id } }
  return { ui }
}
