import { Effect } from "effect"
import * as E from "./events"
import type { ThreadLog } from "./log"
import type { ViewStore } from "./views"

/** The open panels, one activity snapshot per change. */
export const PANELS = "zarg.panels"
/** A plugin asked for a tile or sheet to show (the operator's call opened it): a one-way request clients follow. */
export const NAVIGATE = "zarg.navigate"

/** A panel a plugin opened for one of its agents. `id` is `${plugin}:${name}:${agent}`. */
export interface PanelInstance {
  readonly id: string
  readonly plugin: string
  readonly agent: string
  /** The view store key it shows (see `viewKey`). */
  readonly view: string
  readonly name: string
  readonly scope: "agent" | "shell"
  readonly edge: "top" | "bottom" | "right"
  readonly size: number
  readonly input: "none" | "onFocus"
  /** When it was (re)opened: a panel the operator closed shows again once the plugin opens it again. */
  readonly at?: number
}

/**
 * A thread's surfaces: panels stay until closed (every client sees the same set); tiles and sheets are navigation
 * requests; popovers live in the prompt queue.
 */
export const makeSurfaces = (log: ThreadLog, threadId: string) => {
  const panels = new Map<string, PanelInstance>()
  const send = () => log.append(threadId, E.activitySnapshot(`${threadId}:panels`, { panels: [...panels.values()] }, PANELS))
  const changed = () => Effect.runSync(send())
  return {
    openPanel: (p: PanelInstance) => {
      panels.set(p.id, { ...p, at: Date.now() })
      changed()
    },
    closePanel: (id: string) => {
      if (panels.delete(id)) changed()
    },
    closeAgent: (agent: string) => {
      const gone = [...panels.values()].filter((p) => p.agent === agent)
      for (const p of gone) panels.delete(p.id)
      if (gone.length > 0) changed()
    },
    navigate: (kind: "tile" | "sheet", view: string) => Effect.runSync(log.append(threadId, E.custom(NAVIGATE, { kind, view, at: Date.now() }))),
    /** A new core starts from no panels: the last core's agents are over. */
    announce: Effect.suspend(send),
  }
}
export type Surfaces = ReturnType<typeof makeSurfaces>

/** The view store key of an agent's view: the agent id for the view it started with, `${agent}@${view}` for another. */
export const viewKey = (views: ViewStore, agent: string, view: string | undefined) =>
  view === undefined || views.layout(agent)?.name === view ? agent : `${agent}@${view}`
