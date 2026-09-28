import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { layer as graphLayer } from "@zarg/graph"
import { makeGrants, scopesDigest } from "@zarg/plugin/runtime"
import { layer as hostLayer, type LoadedPlugin, PluginHost } from "@zarg/plugin/server"
import { buildPlugin } from "@zarg/plugin-sdk/tools"

const build = async (entry: string, origin: string): Promise<LoadedPlugin> => {
  const r = await buildPlugin(entry)
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return { manifest: r.manifest as never, bundle: r.bundle, origin }
}
const noul = (p: number) => ({ type: "noul", answer: p >= 0.5, probability: p, confidence: 0 })

describe("rehearse as a loaded plugin", () => {
  test("/rehearse walks gherkin's stories through the host and leaves findings for the developer", async () => {
    const root = mkdtempSync(join(tmpdir(), "zt-rehearse-"))
    mkdirSync(join(root, "intent"))
    writeFileSync(join(root, "intent/zarg.md"), "---\npersonas:\n  - name: The operator\n    text: The operator, through the zarg TUI.\n---\n")
    const plugins = await Promise.all([
      build(join(import.meta.dir, "../../plugin-gherkin/src/index.ts"), join(import.meta.dir, "../../plugin-gherkin")),
      build(join(import.meta.dir, "../src/index.ts"), join(import.meta.dir, "..")),
    ])
    const events: Array<{ plugin: string; event: { event: string; id: string; text?: string } }> = []
    const out = await Effect.gen(function* () {
      const grants = yield* makeGrants({ file: join(mkdtempSync(join(tmpdir(), "zt-rehearse-g-")), "grants.json"), project: root })
      // Rehearse asks for more than the graph: the operator grants it once (`zarg plugin grant rehearse`).
      const m = plugins[1]!.manifest
      yield* grants.approveLoad(m.name, scopesDigest(m.scopes, m.optional, (m.pluginDependencies ?? []).map((d) => d.name)))
      const host = hostLayer(plugins, {
        grants,
        vault: () => Effect.succeed(undefined),
        config: () => ({}),
        ask: () => Effect.succeed("deny"),
        yolo: { on: () => false },
        log: () => {},
        redact: (t) => t,
        firstParty: () => true,
        projectRoot: root,
        decide: (req) =>
          Effect.succeed(
            (req as { questions: Record<string, unknown> }).questions.person !== undefined
              ? { person: noul(0.9) }
              : (req as { questions: Record<string, unknown> }).questions.real !== undefined
                ? { real: noul(0.9), route: { type: "choice", choice: "fix", probabilities: { fix: 1 }, confidence: 1 } }
                : { feel: { type: "score", score: 1.0, level: "poor", probabilities: [], confidence: 0 }, fail: noul(0.3), arrive: noul(0.7) },
          ),
        complete: (req) =>
          Effect.succeed({ text: req.outputSchema !== undefined ? JSON.stringify({ findings: [{ kind: "friction", severity: "medium", note: "unclear" }] }) : "Report.", promptTokens: 1, completionTokens: 1 }),
        agents: (plugin, event) => void events.push({ plugin, event: event as never }),
      })
      return yield* Effect.gen(function* () {
        const h = yield* PluginHost
        yield* h.call("gherkin/add-persona", { name: "Visitor", kind: "human", text: "Someone buying from the shop." })
        yield* h.call("gherkin/add-card", { title: "Visitor opens the cart", when: "the visitor opens the cart", by: [{ name: "Visitor" }], arrives: { text: "the shop is open" }, then: [{ text: "the cart is shown" }] })
        yield* h.call("gherkin/add-card", { title: "Visitor pays", when: "the visitor pays", by: [{ name: "Visitor" }], arrives: { text: "the cart is shown" }, then: [{ text: "the receipt is shown" }] })
        const started = yield* h.invoke("rehearse", "command", { args: [] })
        for (let i = 0; i < 500 && !events.some((e) => e.event.id === "run" && e.event.event === "end"); i++) yield* Effect.sleep(20)
        return { started }
      }).pipe(Effect.provide(Layer.provideMerge(host, graphLayer(join(root, ".zarg/graph")))))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

    expect(out.started).toMatchObject({ notice: expect.stringContaining("started") })
    expect(events.every((e) => e.plugin === "rehearse")).toBe(true)
    expect(events.map((e) => e.event.id)).toContain("tester-1")
    expect(events.find((e) => e.event.event === "start" && e.event.id === "tester-1")?.event).toMatchObject({ view: "tester" })
    const review = events.filter((e) => e.event.id === "run" && e.event.event === "set" && (e.event as { section?: string }).section === "review.findings").at(-1)
    expect(((review?.event as { data?: { rows?: ReadonlyArray<unknown> } } | undefined)?.data?.rows ?? []).length).toBeGreaterThan(0)
    const index = JSON.parse(readFileSync(join(root, ".zarg/rehearse/index.json"), "utf8")) as ReadonlyArray<string>
    expect(index).toHaveLength(1)
  }, 30_000)

  test("starting a run outlasts a slow decision model: run and command get a long deadline", async () => {
    const m = (await build(join(import.meta.dir, "../src/index.ts"), join(import.meta.dir, ".."))).manifest as { methods: Record<string, { deadlineMs?: number }> }
    for (const k of ["run", "command"]) expect(m.methods[k]!.deadlineMs ?? 0).toBeGreaterThanOrEqual(5 * 60_000)
  })
})

test("rehearse declares one card, the run's, and sends the run's findings to zarg from the review queue", async () => {
  const { manifestOf } = await import("@zarg/plugin-sdk/tools")
  const { default: rehearse } = await import("../src")
  const m = manifestOf(rehearse as never)
  expect((m.surfaces ?? []).filter((s) => s.kind === "card")).toEqual([{ kind: "card", name: "run", view: "run", headline: "progress", recent: "testers", action: "apply" }])
  const reviewed = (m.views ?? []).flatMap((v) => v.sections.flatMap((s) => (s.kind === "tabs" ? s.tabs.map((t) => [v.name, `${s.id}.${t.id}`, t.review === true] as const) : [])))
  expect(reviewed.filter(([, , r]) => r).map(([v, p]) => `${v}:${p}`)).toEqual(["run:review.findings"])
  const run = (m.views ?? []).find((v) => v.name === "run")!
  const findings = run.sections.flatMap((s) => (s.kind === "tabs" ? s.tabs : [])).find((t) => t.id === "findings")!
  expect(findings.actions?.find((a) => a.id === "apply")?.label).toBe("Send to zarg")
})
