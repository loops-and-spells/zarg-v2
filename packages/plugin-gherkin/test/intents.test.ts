import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GraphStore } from "@zarg/graph"
import { PluginHost } from "@zarg/plugin/server"
import { call, run } from "./harness"

/** A refusal's words: the tool's message, or every lint finding's. */
const said = (e: { readonly _tag: string; readonly message?: string; readonly findings?: ReadonlyArray<{ readonly message: string }> }) =>
  e._tag === "LintFailed" ? (e.findings ?? []).map((f) => f.message).join("\n") : String(e.message ?? e)

/** Nodes as stored, written directly through the store (a graph a tool could not make, to test checks). */
const put = (nodes: ReadonlyArray<unknown>) => GraphStore.use((g) => g.commit(nodes.map((node) => ({ _tag: "Put", node })) as never))

describe("intent nodes", () => {
  test("an intent and its statements are entities: labelled by title or text, versioned", async () => {
    const got = await run(
      Effect.gen(function* () {
        yield* put([
          { id: "I-0001", type: "gherkin/intent", props: { title: "Plans for visitors", status: "draft" }, edges: [{ type: "gherkin/has", to: "O-0001" }, { type: "gherkin/has", to: "K-0001" }, { type: "gherkin/has", to: "Q-0001" }] },
          { id: "O-0001", type: "gherkin/outcome", props: { text: "A visitor picks a plan in one minute" }, edges: [] },
          { id: "K-0001", type: "gherkin/constraint", props: { text: "Prices never hide fees" }, edges: [] },
          { id: "Q-0001", type: "gherkin/question", props: { text: "Is there a yearly plan?" }, edges: [] },
        ])
        const e = (ref: string) => PluginHost.use((h) => h.entities.get(ref))
        return [yield* e("gherkin/intent:I-0001"), yield* e("gherkin/outcome:O-0001"), yield* e("gherkin/constraint:K-0001"), yield* e("gherkin/question:Q-0001")]
      }),
    )
    expect(got.map((x) => x.label.text)).toEqual(["Plans for visitors", "A visitor picks a plan in one minute", "Prices never hide fees", "Is there a yearly plan?"])
    expect(got.every((x) => /^[0-9a-f]{12}$/.test(x.version))).toBe(true)
  })
})
