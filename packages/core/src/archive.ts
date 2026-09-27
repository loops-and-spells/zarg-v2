import { Effect } from "effect"
import { agentNodes } from "./activity"
import * as E from "./events"
import type { ThreadLog } from "./log"

/** Archive decisions on a thread's agents: `{ archive, reason, at }`, `{ restore }` or `{ delete }`. */
export const ARCHIVE = "zarg.archive"

const HOUR = 60 * 60_000
/** `[agents] ttl`: hours as a number, or "30m", "12h", "2d"; "off" never archives by age. Default 24 hours. */
export const parseTtl = (raw: unknown): number | undefined => {
  if (raw === undefined) return 24 * HOUR
  if (raw === "off") return undefined
  if (typeof raw === "number" && raw > 0) return raw * HOUR
  const m = typeof raw === "string" ? /^(\d+)(m|h|d)$/.exec(raw.trim()) : null
  if (m === null) throw new Error(`[agents] ttl must be hours, "30m", "12h", "2d" or "off" (got ${JSON.stringify(raw)})`)
  return Number(m[1]) * { m: 60_000, h: HOUR, d: 24 * HOUR }[m[2] as "m" | "h" | "d"]
}
const label = (ms: number) => (ms % (24 * HOUR) === 0 ? `${ms / (24 * HOUR)}d` : ms % HOUR === 0 ? `${ms / HOUR}h` : `${Math.round(ms / 60_000)}m`)

/** A thread's archive: finished agents leave the tree (restorable) by hand, at a restart, or after the TTL. */
export const makeArchive = (log: ThreadLog, threadId: string) => {
  const append = (value: Record<string, unknown>) => Effect.runSync(log.append(threadId, E.custom(ARCHIVE, value)))
  /** Agents archived now (not restored) and deleted for good, from the log. */
  const state = () => {
    const archived = new Set<string>()
    const deleted = new Set<string>()
    for (const e of log.all()) {
      if (e.threadId !== threadId || e.type !== "CUSTOM" || e.name !== ARCHIVE) continue
      const v = e.value as { archive?: ReadonlyArray<string>; restore?: ReadonlyArray<string>; delete?: ReadonlyArray<string> }
      for (const id of v.archive ?? []) archived.add(id)
      for (const id of v.restore ?? []) archived.delete(id)
      for (const id of v.delete ?? []) deleted.add(id)
    }
    return { archived, deleted }
  }
  const archive = (ids: ReadonlyArray<string>, reason: string) => {
    if (ids.length > 0) append({ archive: ids, reason, at: Date.now() })
  }
  return {
    archive,
    restore: (ids: ReadonlyArray<string>) => (ids.length > 0 ? append({ restore: ids }) : undefined),
    remove: (ids: ReadonlyArray<string>) => (ids.length > 0 ? append({ delete: ids }) : undefined),
    /** Finished agents that ended `ttl` ago or more, and ask for nobody's attention, leave the tree. */
    sweep: (ttl: number, now: number) => {
      const { archived, deleted } = state()
      const due = agentNodes(log)
        .filter((s) => s.threadId === threadId)
        .flatMap((s) => [...s.nodes.entries()])
        .filter(([id, n]) => id !== "zarg" && n.status !== "running" && n.attention === undefined && typeof n.endedAt === "number" && now - n.endedAt >= ttl && !archived.has(id) && !deleted.has(id))
        .map(([id]) => id)
      archive(due, `ttl (${label(ttl)})`)
    },
  }
}
export type Archive = ReturnType<typeof makeArchive>
