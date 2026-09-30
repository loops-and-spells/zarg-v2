import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makePlanner } from "../src/planner"

const item = (over: Record<string, unknown> = {}) => ({
  id: "B-01", title: "Grant prompt", journey: "Set up", cards: [{ ref: "gherkin/card:UX-0001@abc" }],
  changes: [{ tool: "edit-state", params: { id: "S-0002", text: "x" } }, { tool: "add-card", params: { title: "y" } }],
  feedback: [], steps: [], status: "ready", events: [], ...over,
})
const setup = (o: { planned?: ReadonlyArray<string>; next?: unknown; fail?: string; reconcile?: boolean; running?: ReadonlyArray<unknown>; movedFails?: boolean; dirty?: ReadonlyArray<string>; gone?: ReadonlyArray<string> } = {}) => {
  const log: Array<unknown> = []
  let nexts = [o.next === undefined ? item() : o.next]
  const p = makePlanner({
    invoke: (plugin, method, params) =>
      o.movedFails === true && method === "moved"
        ? Effect.fail({ _tag: "PluginError", message: "disk full" })
        : Effect.sync(() => {
            log.push([plugin, method, params])
            return method === "next" ? (nexts.shift() ?? null) : null
          }),
    // All of a plan's calls under one hold of the graph lock (the host's `calls`), with its hooks.
    calls: (list, hooks) =>
      Effect.gen(function* () {
        const b = yield* hooks.before
        const touched: Array<string> = []
        for (const c of list) {
          if (o.fail !== undefined && c.name === "gherkin/add-card") {
            yield* Effect.ignore(hooks.failure(b, touched))
            return yield* Effect.fail({ touched, error: { _tag: "LintFailed", message: `${c.name}: ${o.fail}` } })
          }
          if (c.name === "gherkin/edit-card" && (c.params as { id: string }).id === "UX-GONE") {
            yield* Effect.ignore(hooks.failure(b, touched))
            return yield* Effect.fail({ touched, error: { _tag: "ToolError", message: "no card UX-GONE" } })
          }
          log.push(["call", c.name, c.params])
          if (c.name === "gherkin/edit-card" && (o.planned ?? []).includes((c.params as { id: string }).id)) touched.push((c.params as { id: string }).id)
          touched.push(...(c.name.endsWith("add-card") ? ["UX-0009"] : c.name.endsWith("edit-state") ? ["S-0002"] : []))
        }
        return { touched, before: b, after: yield* hooks.after(b, touched) }
      }),
    snapshot: Effect.succeed("graph"),
    affected: () => Effect.succeed({ cards: ["UX-0001", "UX-0009"] }),
    files: () => Effect.succeed({ restore: (ids: ReadonlyArray<string>) => Effect.sync(() => void log.push(["restore", ids])), dirty: (ids: ReadonlyArray<string>) => Effect.succeed(ids.filter((id) => (o.dirty ?? []).includes(id))) }),
    exists: (card) => Effect.succeed(!(o.gone ?? []).includes(card)),
    commit: (ids, message) => Effect.sync(() => (log.push(["commit", ids, message]), "abcdef0123")),
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
      ["backlog", "moved", { id: "B-01", to: "running", by: "Planner", what: "applied in abcdef0", cards: ["UX-0001", "UX-0009"] }],
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
    expect(log.at(-1)).toEqual(["backlog", "moved", { id: "B-01", to: "review", by: "Planner", what: "applied in abcdef0; reconcile is off: implement by hand", cards: ["UX-0001", "UX-0009"] }])
  })
  test("nothing Ready: nothing happens", async () => {
    const { p, log } = setup({ next: null })
    await Effect.runPromise(p.tick)
    expect(log).toEqual([["backlog", "next", {}]])
  })
  test("a landed pass moves Running plans whose cards all landed to Review", async () => {
    const { p, log } = setup({ running: [{ id: "B-01", data: item({ status: "running", cards: [{ ref: "gherkin/card:UX-0001@abc" }, { ref: "gherkin/card:UX-0002@def" }] }) }, { id: "B-02", data: item({ id: "B-02", status: "running" }) }] })
    await Effect.runPromise(p.landed(["UX-0001"]))
    expect(log).toEqual([["call", "gherkin/edit-card", { id: "UX-0001", planned: false }], ["backlog", "moved", { id: "B-02", to: "review", by: "reconcile", what: "landed" }]])
  })
  test("the Running move fails: nothing is applied", async () => {
    const { p, log } = setup({ movedFails: true })
    await Effect.runPromise(p.tick)
    expect(log).toEqual([["backlog", "next", {}]])
  })
  test("a node the operator changed and has not committed: the apply is undone and the plan waits for them", async () => {
    const { p, log } = setup({ dirty: ["S-0002"] })
    await Effect.runPromise(p.tick)
    expect(log.filter((l) => (l as Array<unknown>)[0] === "commit")).toEqual([])
    expect(log).toContainEqual(["restore", ["S-0002", "UX-0009"]])
    expect(log.at(-1)).toEqual(["backlog", "moved", { id: "B-01", to: "ready", by: "Planner", what: "waits for your graph edits", needs: "commit your uncommitted changes to S-0002 first (the plan changes them too)" }])
  })
  test("a failed pass on a plan's card puts it back in Ready for the operator; a card the plan removed counts as landed", async () => {
    const { p, log } = setup({ gone: ["UX-0002"], running: [{ id: "B-01", data: item({ status: "running", cards: [{ ref: "gherkin/card:UX-0001@abc" }, { ref: "gherkin/card:UX-0002@def" }] }) }, { id: "B-03", data: item({ id: "B-03", status: "running", cards: [{ ref: "gherkin/card:UX-0007@abc" }] }) }] })
    await Effect.runPromise(p.landed(["UX-0001"]))
    await Effect.runPromise(p.failed(["UX-0007"]))
    expect(log).toEqual([
      ["call", "gherkin/edit-card", { id: "UX-0001", planned: false }],
      ["backlog", "moved", { id: "B-01", to: "review", by: "reconcile", what: "landed" }],
      ["backlog", "moved", { id: "B-03", to: "ready", by: "reconcile", what: "the pass failed on UX-0007", needs: "the reconcile pass failed on UX-0007: see the driver's agenda, then move it to Ready" }],
    ])
  })
  test("a landed pass clears planned on its cards and commits it; a card that fails does not stop the rest", async () => {
    const { p, log } = setup({ running: [], planned: ["UX-0026"] })
    await Effect.runPromise(p.landed(["UX-GONE", "UX-0026", "UX-0031"]))
    expect(log).toEqual([
      ["call", "gherkin/edit-card", { id: "UX-0026", planned: false }],
      ["commit", ["UX-0026"], "req: UX-0026 is built (landed)"],
      ["call", "gherkin/edit-card", { id: "UX-0031", planned: false }],
    ])
  })
  test("a code plan the operator moved to Running is theirs: a landed or failed pass leaves it", async () => {
    const { p, log } = setup({ running: [{ id: "B-05", data: item({ id: "B-05", status: "running", kind: "code" }) }] })
    await Effect.runPromise(p.landed(["UX-0001"]))
    await Effect.runPromise(p.failed(["UX-0001"]))
    expect(log.filter((l) => (l as Array<unknown>)[1] === "moved")).toEqual([])
  })
})
