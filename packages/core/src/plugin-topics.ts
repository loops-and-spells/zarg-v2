import { Effect } from "effect"
import type { InboxService } from "./inbox"

const PLUGIN_ITEM = /^plugin-(disabled|failed|needs):/
/** The host's plugin problems as inbox topics: one per problem, settled once it is gone. */
export const syncPluginTopics = (inbox: InboxService, items: ReadonlyArray<{ readonly id: string; readonly title: string; readonly detail: string }>) =>
  Effect.gen(function* () {
    const now = items.filter((i) => PLUGIN_ITEM.test(i.id))
    for (const i of now) yield* inbox.post({ plugin: "zarg" }, { kind: "plugin", key: i.id, title: i.title, why: "plugin", evidence: i.detail, severity: "high" })
    const keys = new Set(now.map((i) => i.id))
    for (const t of inbox.list())
      if (t.from.plugin === "zarg" && t.kind === "plugin" && t.state === "open" && t.key !== undefined && !keys.has(t.key)) yield* inbox.settle("zarg", t.id, "the plugin loaded")
  })
