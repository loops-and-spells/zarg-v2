import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { buildPlugin, writeDist } from "@zarg/plugin-sdk/tools"
import { type LoadedPlugin, loadPluginDir } from "../src/server"
import { hostWith } from "./fixtures"

/** An evidence plugin built to a dist with its assets, as `zarg plugin build` would. */
const evidencePlugin = async (name: string, render: string, assets: ReadonlyArray<string> = []): Promise<LoadedPlugin> => {
  const dir = join(import.meta.dir, "fixtures", ".gen", name)
  mkdirSync(join(dir, "assets"), { recursive: true })
  for (const a of assets) writeFileSync(join(dir, a), `/* ${a} */\n`)
  const service = name.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
  writeFileSync(
    join(dir, "index.ts"),
    `import { Effect, Schema } from "effect"
import { definePlugin, PluginFailure } from "@zarg/plugin-sdk"
export default definePlugin({
  name: "${name}", service: "${service}", archetype: "service", config: Schema.Struct({}), scopes: { evidence: true },
  evidence: { note: { label: "note", files: "text" } }, assets: ${JSON.stringify(assets)},
  methods: { renderEvidence: { doc: "Render.", params: Schema.Unknown, success: Schema.Unknown } },
  make: Effect.succeed({ renderEvidence: (input: any) => ${render} }),
})
`,
  )
  const r = await buildPlugin(join(dir, "index.ts"))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  writeDist(dir, r)
  return Effect.runPromise(loadPluginDir(join(dir, "dist")))
}

// @scenario S-0120
test("the host renders a medium through the plugin that owns its kind; anything else is a reason, never a failure", async () => {
  const good = await evidencePlugin("evidence-good", `Effect.succeed({ html: "<p class=n>" + input.files[0].text + "</p>", assets: ["n.css"] })`, ["assets/n.css"])
  const bad = await evidencePlugin("evidence-bad", `Effect.fail(new PluginFailure({ tag: "PluginError", message: "cannot draw" }))`)
  const sly = await evidencePlugin("evidence-sly", `Effect.succeed({ html: "<p>x</p>", assets: ["../../etc/passwd"] })`)
  const odd = await evidencePlugin("evidence-odd", `Effect.succeed({ html: 42 })`)
  const input = (kind: string) => ({ kind, caption: "c", files: [{ name: "1-note.txt", url: "media/S-1/1-note.txt", text: "hello" }] })
  const r = await Effect.runPromise(
    hostWith([good, bad, sly, odd], (h) =>
      Effect.gen(function* () {
        return {
          kinds: h.evidence.kinds(),
          good: yield* h.evidence.render(input("evidence-good/note")),
          bad: yield* h.evidence.render(input("evidence-bad/note")),
          sly: yield* h.evidence.render(input("evidence-sly/note")),
          odd: yield* h.evidence.render(input("evidence-odd/note")),
          missing: yield* h.evidence.render(input("evidence-missing/x")),
        }
      }),
    ),
  )
  expect(r.kinds["evidence-good/note"]).toEqual({ owner: "evidence-good", label: "note", files: "text" })
  expect(r.good).toEqual({ ok: true, owner: "evidence-good", html: '<p class=n>hello</p>', assets: [{ name: "n.css", path: good.assets!["n.css"]! }] })
  expect(r.bad).toMatchObject({ ok: false, reason: expect.stringContaining("evidence-bad could not render evidence-bad/note: cannot draw") })
  expect(r.sly).toEqual({ ok: false, reason: "asset ../../etc/passwd is not one evidence-sly declared" })
  expect(r.odd).toEqual({ ok: false, reason: "evidence-odd could not render evidence-odd/note: it returned no html" })
  expect(r.missing).toEqual({ ok: false, reason: "rendered by evidence-missing, not installed" })
})
