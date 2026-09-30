import { Effect } from "effect"
import type { InboxService } from "./inbox"

const PLUGIN_ITEM = /^plugin-(disabled|failed|needs):/
/** The host's plugin problems as inbox topics: one per problem, settled once it is gone. */
export const syncPluginTopics = (inbox: InboxService, items: ReadonlyArray<{ readonly id: string; readonly title: string; readonly detail: string }>) =>
  Effect.gen(function* () {
    const now = items.filter((i) => PLUGIN_ITEM.test(i.id))
    // One the operator already read or answered stays so: a later sync never raises it again.
    const seen = new Set(inbox.list().filter((t) => t.from.plugin === "zarg" && (t.state === "read" || t.state === "answered")).map((t) => t.key))
    for (const i of now.filter((x) => !seen.has(x.id))) yield* inbox.post({ plugin: "zarg" }, { kind: "plugin", key: i.id, title: i.title, why: "plugin", evidence: i.detail, severity: "high" })
    const keys = new Set(now.map((i) => i.id))
    for (const t of inbox.list())
      if (t.from.plugin === "zarg" && t.kind === "plugin" && t.state === "open" && t.key !== undefined && !keys.has(t.key)) yield* inbox.settle("zarg", t.id, "the plugin loaded")
  })
