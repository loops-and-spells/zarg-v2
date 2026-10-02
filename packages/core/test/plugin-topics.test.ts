import { expect, test } from "bun:test"
import { Effect } from "effect"
import { syncFindingTopics, syncPluginTopics } from "../src/plugin-topics"
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

test("a plugin topic the operator read does not come back as a new one when the host syncs again", async () => {
  const { inbox } = await setup()
  const item = { id: "plugin-disabled:x", title: "Plugin x was disabled", detail: "Restart zarg.", about: [], priority: 1 }
  await Effect.runPromise(syncPluginTopics(inbox, [item]))
  await Effect.runPromise(inbox.read(inbox.list()[0]!.id))
  await Effect.runPromise(syncPluginTopics(inbox, [item, { id: "plugin-failed:y", title: "Plugin y failed", detail: "", about: [], priority: 1 }]))
  expect(inbox.list().map((t) => [t.key, t.state]).sort()).toEqual([["plugin-disabled:x", "read"], ["plugin-failed:y", "open"]])
})

test("a reconcile finding is a finding topic (zarg takes it up: no answers); it settles when the finding clears", async () => {
  const { inbox } = await setup()
  const f = { id: "finding-1", kind: "verify-failing" as const, title: "verify still fails after the fix attempts", detail: "2 tests failed", about: ["C-0023"], pass: "p1", at: "2026-09-30" }
  await Effect.runPromise(syncFindingTopics(inbox, [f]))
  await Effect.runPromise(syncFindingTopics(inbox, [f]))
  expect(inbox.list().map((t) => [t.kind, t.key, t.title, t.about, t.answers, t.state])).toEqual([["finding", "finding:finding-1", "verify still fails after the fix attempts", ["C-0023"], undefined, "open"]])
  await Effect.runPromise(syncFindingTopics(inbox, []))
  expect(inbox.list()[0]).toMatchObject({ state: "moot", moot: "the finding cleared" })
})

test("a finding topic the operator read is not raised again while the finding stays; reconcile off settles with that reason", async () => {
  const { inbox } = await setup()
  const f = { id: "finding-2", kind: "blocked-card" as const, title: "C-0024 cannot be implemented", detail: "contradicts C-0023", about: ["C-0024"], pass: "p1", at: "2026-09-30" }
  await Effect.runPromise(syncFindingTopics(inbox, [f]))
  await Effect.runPromise(inbox.read(inbox.list()[0]!.id))
  await Effect.runPromise(syncFindingTopics(inbox, [f]))
  expect(inbox.list().map((t) => t.state)).toEqual(["read"])
  await Effect.runPromise(syncFindingTopics(inbox, [{ ...f, id: "finding-3" }]))
  await Effect.runPromise(syncFindingTopics(inbox, [], "reconcile is off"))
  expect(inbox.list().find((t) => t.key === "finding:finding-3")).toMatchObject({ state: "moot", moot: "reconcile is off" })
})
