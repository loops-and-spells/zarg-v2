import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makePlanner } from "../src/planner"

const item = (over: Record<string, unknown> = {}) => ({
  id: "B-01", title: "Grant prompt", journey: "Set up", cards: [{ ref: "gherkin/card:UX-0001@abc" }],
  changes: [{ tool: "edit-state", params: { id: "S-0002", text: "x" } }, { tool: "add-card", params: { title: "y" } }],
  feedback: [], steps: [], status: "ready", events: [], ...over,
})
const setup = (o: { next?: unknown; fail?: string; reconcile?: boolean; running?: ReadonlyArray<unknown> } = {}) => {
  const log: Array<unknown> = []
  let nexts = [o.next === undefined ? item() : o.next]
  const p = makePlanner({
    invoke: (plugin, method, params) =>
      Effect.sync(() => {
        log.push([plugin, method, params])
        return method === "next" ? (nexts.shift() ?? null) : null
      }),
    call: (name, params) =>
      o.fail !== undefined && name === "gherkin/add-card"
        ? Effect.fail({ _tag: "LintFailed", message: o.fail })
        : Effect.sync(() => (log.push(["call", name, params]), { message: "ok", added: name.endsWith("add-card") ? ["UX-0009"] : [], changed: name.endsWith("edit-state") ? ["S-0002"] : [], removed: [], warnings: [] })),
    exclusive: (e) => e,
    commit: (ids, message) => Effect.sync(() => (log.push(["commit", ids, message]), "abcdef0123")),
    restore: (ids) => Effect.sync(() => void log.push(["restore", ids])),
    notify: () => void log.push(["notify"]),
    reconcileOn: () => o.reconcile !== false,
    running: () => Effect.succeed((o.running ?? []) as never),
  })
  return { p, log }
}

describe("the Planner", () => {
  test("takes the next Ready plan: Running first, applies its changes in order, commits exactly those nodes, notifies reconcile", async () => {
    const { p, log } = setup()
    await Effect.runPromise(p.tick)
    expect(log).toEqual([
      ["backlog", "next", {}],
      ["backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applying 2 changes" }],
      ["call", "gherkin/edit-state", { id: "S-0002", text: "x" }],
      ["call", "gherkin/add-card", { title: "y" }],
      ["commit", ["S-0002", "UX-0009"], "req: Grant prompt (B-01)"],
      ["backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applied in abcdef0" }],
      ["notify"],
    ])
  })
  test("a change that fails: nothing committed, the touched nodes restored, the plan back in Ready needing the operator", async () => {
    const { p, log } = setup({ fail: "a card needs a Then" })
    await Effect.runPromise(p.tick)
    expect(log.filter((l) => (l as Array<unknown>)[0] === "commit")).toEqual([])
    expect(log).toContainEqual(["restore", ["S-0002"]])
    expect(log.at(-1)).toEqual(["backlog", "moved", { id: "B-01", to: "ready", by: "Planner", what: "apply failed", needs: "gherkin/add-card: a card needs a Then" }])
  })
  test("with reconcile off the plan goes to Review, to be implemented by hand", async () => {
    const { p, log } = setup({ reconcile: false })
    await Effect.runPromise(p.tick)
    expect(log.at(-1)).toEqual(["backlog", "moved", { id: "B-01", to: "review", by: "Planner", what: "applied in abcdef0; reconcile is off: implement by hand" }])
  })
  test("nothing Ready: nothing happens", async () => {
    const { p, log } = setup({ next: null })
    await Effect.runPromise(p.tick)
    expect(log).toEqual([["backlog", "next", {}]])
  })
  test("a landed pass moves Running plans whose cards all landed to Review", async () => {
    const { p, log } = setup({ running: [{ id: "B-01", data: item({ status: "running", cards: [{ ref: "gherkin/card:UX-0001@abc" }, { ref: "gherkin/card:UX-0002@def" }] }) }, { id: "B-02", data: item({ id: "B-02", status: "running" }) }] })
    await Effect.runPromise(p.landed(["UX-0001"]))
    expect(log).toEqual([["backlog", "moved", { id: "B-02", to: "review", by: "reconcile", what: "landed" }]])
  })
})
