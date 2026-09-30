import { expect, test } from "bun:test"
import { Effect } from "effect"
import { syncPluginTopics } from "../src/plugin-topics"
import { setup } from "./inbox-helper"

test("a disabled plugin becomes a plugin topic; syncing again with it gone settles it", async () => {
  const { inbox } = await setup()
  const item = { id: "plugin-disabled:x", title: "Plugin x was disabled after 3 restarts", detail: "Restart zarg to try it again.", about: [], priority: 1 }
  await Effect.runPromise(syncPluginTopics(inbox, [item, { id: "backlog:needs:B-1", title: "t", detail: "", about: [], priority: 1 }]))
  await Effect.runPromise(syncPluginTopics(inbox, [item]))
  expect(inbox.list().map((t) => [t.kind, t.key, t.state, t.evidence])).toEqual([["plugin", "plugin-disabled:x", "open", "Restart zarg to try it again."]])
  await Effect.runPromise(syncPluginTopics(inbox, []))
  expect(inbox.list()[0]).toMatchObject({ state: "moot", moot: "the plugin loaded" })
})
