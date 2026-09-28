import type { SessionState } from "@zarg/client"
import { keyFor } from "@zarg/view"
import { displayName } from "./rail"
import { liveRlms } from "./view"

type ActionSpec = { readonly id: string; readonly label: string; readonly key?: string; readonly keys?: Readonly<Record<string, string>>; readonly on: "selection" | "row" | "none" }
export interface ReviewRow {
  /** `${agent}|${section}|${rowId}`: the row's place in the queue's selection. */
  readonly key: string
  readonly agent: string
  readonly section: string
  readonly row: { readonly id: string; readonly cells: Readonly<Record<string, string>>; readonly tone?: string }
}
/** One review table of one agent: its rows, columns and actions. */
export interface ReviewGroup {
  readonly agent: string
  readonly name: string
  readonly section: string
  readonly rows: ReadonlyArray<ReviewRow>
  readonly columns: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly actions: ReadonlyArray<ActionSpec>
}

/** Every table marked `review` in every live agent's views, one group per agent and table, in the rail's order. */
export const reviewGroups = (s: SessionState): ReadonlyArray<ReviewGroup> => {
  const live = liveRlms(s)
  const views = Object.values(s.thread.views ?? {})
  return Object.values(live).flatMap((n) =>
    views
      .filter((v) => v.agent === n.id || v.agent.startsWith(`${n.id}@`))
      .flatMap((v) =>
        v.layout.sections
          .flatMap((sec) => (sec.kind === "tabs" ? sec.tabs.map((t) => ({ path: `${sec.id}.${t.id}`, leaf: t })) : [{ path: sec.id, leaf: sec }]))
          .filter((l) => l.leaf.kind === "table" && l.leaf.review === true)
          .map((l): ReviewGroup => {
            const rows = ((v.data[l.path] as { rows?: ReadonlyArray<ReviewRow["row"]> } | undefined)?.rows ?? []).map((row) => ({ key: `${n.id}|${l.path}|${row.id}`, agent: n.id, section: l.path, row }))
            return { agent: n.id, name: displayName(n), section: l.path, rows, columns: l.leaf.columns ?? [], actions: (l.leaf.actions ?? []) as ReadonlyArray<ActionSpec> }
          })
          .filter((g) => g.rows.length > 0),
      ),
  )
}

/** A key over the selection (the cursor row when nothing is selected): one act per agent and table, with its rows only. */
export const reviewActs = (groups: ReadonlyArray<ReviewGroup>, cursor: number, selected: ReadonlyArray<string>, key: string) => {
  const all = groups.flatMap((g) => g.rows)
  const picked = selected.length > 0 ? selected : all[cursor] !== undefined ? [all[cursor]!.key] : []
  return groups.flatMap((g) => {
    const a = g.actions.find((x) => keyFor(x, "terminal") === key)
    const rows = g.rows.filter((r) => picked.includes(r.key)).map((r) => r.row.id)
    return a === undefined || rows.length === 0 ? [] : [{ agent: g.agent, section: g.section, action: a.id, rows }]
  })
}
