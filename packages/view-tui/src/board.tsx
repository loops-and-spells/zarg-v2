import type { ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useRef } from "react"
import { boardUi, type ViewState, type ViewUi } from "@zarg/view"
import { fit } from "./look"
import { useColors, useToneFg } from "./theme"

type Card = { readonly id: string; readonly title: string; readonly tone?: string; readonly top?: string; readonly badge?: string; readonly lines?: ReadonlyArray<{ readonly text: string; readonly tone?: string }> }
type Lane = { readonly id: string; readonly title: string; readonly cards: ReadonlyArray<Card> }
const FOLDED = 3
const GAP = 2

/** A title wrapped to a width, whole (never cut off). */
const wrap = (t: string, w: number): ReadonlyArray<string> => {
  const lines: Array<string> = [""]
  for (const word of t.split(/\s+/).filter((x) => x.length > 0)) {
    const next = `${lines.at(-1)!} ${word}`.trim()
    if (next.length <= w || lines.at(-1)!.length === 0) lines[lines.length - 1] = next.length <= w ? next : word.slice(0, w)
    else lines.push(word.slice(0, w))
  }
  return lines
}

/** A folded lane: its count on the header row (in line with the others'), ▸, then its title top to bottom. */
const Strip = (p: { readonly lane: Lane; readonly on: boolean }) => {
  const C = useColors()
  return (
    <box style={{ width: FOLDED, marginRight: 1, flexDirection: "column", flexShrink: 0, alignItems: "center", backgroundColor: p.on ? C.selection : C.raised }}>
      <text fg={C.dim}>{String(p.lane.cards.length)}</text>
      <text fg={p.on ? C.accent : C.faint}>{"▸"}</text>
      {p.lane.title.toUpperCase().split("").map((ch, i) => (
        <text key={i} fg={p.on ? C.accent : C.text}>
          <b>{ch}</b>
        </text>
      ))}
    </box>
  )
}

/** One card: a severity stripe, its top line and badge, the whole title, then its lines. */
const CardBox = (p: { readonly card: Card; readonly on: boolean; readonly width: number; readonly id: string }) => {
  const C = useColors()
  const fg = useToneFg()
  const bg = p.on ? C.selection : C.raised
  const w = Math.max(4, p.width - 1)
  const stripe = <span fg={p.card.tone !== undefined ? fg(p.card.tone) : C.faint}>{"▌"}</span>
  const top = p.card.top ?? p.card.id
  const badge = p.card.badge ?? ""
  return (
    <box id={p.id} style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
      <text wrapMode="none" bg={bg}>
        {stripe}
        <span fg={C.dim}>{fit(top, Math.max(1, w - badge.length - 1)).padEnd(Math.max(1, w - badge.length))}</span>
        <span fg={C.dim}>{badge}</span>
      </text>
      {wrap(p.card.title, w).map((l, i) => (
        <text key={i} wrapMode="none" bg={bg}>
          {stripe}
          <span fg={C.text}>{p.on ? <b>{l.padEnd(w)}</b> : l.padEnd(w)}</span>
        </text>
      ))}
      {(p.card.lines ?? []).map((l, i) => (
        <text key={`l${i}`} wrapMode="none" bg={bg}>
          {stripe}
          <span fg={l.tone !== undefined ? fg(l.tone) : C.dim}>{fit(l.text, w).padEnd(w)}</span>
        </text>
      ))}
    </box>
  )
}

/** A kanban: open lanes side by side, each its own scroll container; folded lanes are narrow strips. */
export const Board = (p: { readonly view: ViewState; readonly ui: ViewUi; readonly path: string; readonly focused: boolean; readonly width: number }) => {
  const C = useColors()
  const lanes = ((p.view.data[p.path] as { lanes?: ReadonlyArray<Lane> } | undefined)?.lanes ?? [])
  const b = boardUi(p.view, p.ui, p.path)
  const folded = lanes.filter((l) => b.folded.includes(l.id)).length
  const open = lanes.length - folded
  const laneWidth = open === 0 ? 0 : Math.max(8, Math.floor((p.width - folded * (FOLDED + 1) - open * GAP) / open))
  const scrolls = useRef(new Map<string, ScrollBoxRenderable>())
  // The cursor card stays in view: its lane scrolls to it (the others do not move).
  const cursorLane = lanes[b.lane]
  useEffect(() => {
    if (cursorLane === undefined) return
    const t = setTimeout(() => scrolls.current.get(cursorLane.id)?.scrollChildIntoView(`card-${p.path}-${cursorLane.id}-${b.card}`), 0)
    return () => clearTimeout(t)
  })
  if (lanes.length === 0) return <text fg={C.dim}>nothing yet</text>
  return (
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      {lanes.map((lane, li) => {
        const here = p.focused && li === b.lane
        if (b.folded.includes(lane.id)) return <Strip key={lane.id} lane={lane} on={here} />
        return (
          <box key={lane.id} style={{ width: laneWidth, marginRight: GAP, flexDirection: "column", flexShrink: 0 }}>
            <text wrapMode="none">
              <span fg={here ? C.accent : C.text}>
                <b>{lane.title}</b>
              </span>
              <span fg={C.dim}>{` ${lane.cards.length}`.padEnd(Math.max(1, laneWidth - lane.title.length - 1))}</span>
              <span fg={C.faint}>{"◂"}</span>
            </text>
            <text wrapMode="none" fg={here ? C.accent : C.faint}>
              {(here ? "▔" : "─").repeat(laneWidth)}
            </text>
            <scrollbox
              focusable={false}
              ref={(r: ScrollBoxRenderable | null) => void (r === null ? scrolls.current.delete(lane.id) : scrolls.current.set(lane.id, r))}
              style={{ flexGrow: 1, flexBasis: 0 }}
            >
              {lane.cards.map((c, ci) => (
                <CardBox key={c.id} id={`card-${p.path}-${lane.id}-${ci}`} card={c} on={here && ci === b.card} width={laneWidth - 1} />
              ))}
            </scrollbox>
          </box>
        )
      })}
    </box>
  )
}
