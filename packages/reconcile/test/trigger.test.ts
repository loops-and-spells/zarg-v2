import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { engineLayer, makeTrigger, Pass, passLayer, startReconciler } from "../src"
import { card, cleanup, repo, sh, state, writeNode } from "./repo"
import { stubSpec } from "./stub-spec"

afterAll(cleanup)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("trigger", () => {
  test("runs once after quiet; a notify during a run brings exactly one more run", async () => {
    let runs = 0
    let release: () => void = () => {}
    const t = makeTrigger(30, () => {
      runs++
      return new Promise<void>((r) => (release = r))
    })
    t.notify()
    t.notify()
    await sleep(10)
    t.notify()
    await sleep(60)
    expect(runs).toBe(1)
    t.notify()
    t.notify()
    await sleep(60)
    expect(runs).toBe(1)
    release()
    await sleep(80)
    expect(runs).toBe(2)
    release()
    await sleep(80)
    expect(runs).toBe(2)
    t.close()
  })
})

describe("reconciler", () => {
  const start = (r: string) => {
    const spec = stubSpec(r)
    const results: Array<string> = []
    const layer = passLayer(spec).pipe(Layer.provideMerge(engineLayer(join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db"))))
    const rec = startReconciler({
      repo: r,
      quietMs: 50,
      findings: spec.findings,
      execute: (p) => Pass.execute(p).pipe(Effect.provide(layer)) as never,
      onResult: (x) => results.push(x.status),
    })
    return { rec, results, spec }
  }
  const until = async (cond: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!cond() && Date.now() < end) await sleep(50)
  }

  // @card UX-0020
  test("a graph edit is reconciled into a landed commit after the quiet period", async () => {
    const r = repo()
    const { rec, results } = start(r)
    writeNode(r, state("S-0001", "home"))
    writeNode(r, card("UX-0001", "S-0001", "S-0001"))
    // Under load the two files may land in separate quiet periods: an early pass then finds nothing to do.
    await until(() => results.includes("landed"))
    rec.close()
    // Extra quiet periods may add passes that find nothing (or find it already reconciled): exactly one lands.
    expect(results.filter((x) => x === "landed")).toEqual(["landed"])
    expect(results.every((x) => x === "landed" || x === "nothing" || x === "skipped")).toBe(true)
    expect(sh(r, "git log -1 --format=%s")).toBe("feat: implement UX-0001")
  }, 20_000)

  test("a checkout it cannot land on (detached HEAD) raises a finding instead of running", async () => {
    const r = repo()
    sh(r, "git checkout -q --detach")
    const { rec, results, spec } = start(r)
    rec.notify()
    await until(() => results.length > 0)
    rec.close()
    expect(results).toEqual(["skipped"])
    expect(spec.findings.list().map((f) => f.kind)).toEqual(["pass-error"])
  })
})
