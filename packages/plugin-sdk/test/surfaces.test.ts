import { expect, test } from "bun:test"
import { Effect } from "effect"
import { defineView } from "@zarg/view"
import { servicesFrom } from "../src/services"

test("Surfaces open and close as agents events; view pushes name their view", async () => {
  const calls: Array<[string, unknown]> = []
  const s = servicesFrom({ call: async (p, a) => (calls.push([p, a]), null) })
  const V = defineView("run", { line: { kind: "stats", role: "summary" } })
  await Effect.runPromise(s.surfaces.open([{ surface: "status", agent: "run" }, { surface: "main", agent: "run", focus: true }]))
  await Effect.runPromise(s.surfaces.close("status", "run"))
  await Effect.runPromise(s.views.set("run", V, "line", { items: [] }))
  expect(calls).toEqual([
    ["agents.event", { event: "open", surfaces: [{ surface: "status", agent: "run" }, { surface: "main", agent: "run", focus: true }] }],
    ["agents.event", { event: "close", surface: "status", id: "run" }],
    ["agents.event", { event: "set", id: "run", view: "run", section: "line", data: { items: [] } }],
  ])
})
