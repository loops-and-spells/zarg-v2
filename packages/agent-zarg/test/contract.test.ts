import { expect, test } from "bun:test"
import type { Effect } from "effect"
import type { Thread } from "@zarg/agent-host"
import zarg from "../src"
import type { makeThread } from "../src/thread"

// zarg's thread is the Thread the core serves: a compile-time check.
type Made = Effect.Success<ReturnType<typeof makeThread>>
const assignable: Thread = null as unknown as Made
void assignable

test("zarg is a trusted agent named zarg", () => {
  expect(zarg.name).toBe("zarg")
})

test("zarg opens its bar at start: a shell panel at the bottom, one line, taking keys", async () => {
  const { Effect } = await import("effect")
  const opened: Array<unknown> = []
  const host = { root: "/zt", roles: {}, rlmSettings: {}, model: {}, decisions: {}, plugins: {}, store: { snapshot: Effect.succeed({}) }, log: {}, sensitive: [], agenda: () => Effect.succeed([]), outsideReads: {}, findings: { chosen: {}, firstParty: () => false }, panels: { open: (p: unknown) => void opened.push(p) } }
  await Effect.runPromise(zarg.start(host as never))
  expect(opened).toEqual([{ name: "bar", view: "zarg", scope: "shell", edge: "bottom", size: 1, input: "onFocus" }])
})
