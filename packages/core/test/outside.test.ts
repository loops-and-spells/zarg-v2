import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeGrants } from "@zarg/plugin/runtime"
import type { Question } from "@zarg/rlm"
import { outsideReads } from "../src/outside"

const setup = (answers: Array<string>) =>
  Effect.gen(function* () {
    const base = mkdtempSync(join(tmpdir(), "zarg-outside-"))
    const other = join(base, "zarg")
    mkdirSync(join(other, ".git"), { recursive: true })
    mkdirSync(join(other, "src", "vm"), { recursive: true })
    writeFileSync(join(other, "src", "vm", "grid.ts"), "export {}\n")
    const grants = yield* makeGrants({ file: join(base, "user", "grants.json"), project: join(base, "project") })
    const asked: Array<Question> = []
    const allow = outsideReads({ grants, userDir: join(base, "user"), ask: (q) => Effect.sync(() => (asked.push(q), { choice: answers.shift() ?? "deny" })) })
    const read = (p: string) => Effect.runPromise(Effect.result(allow(p)))
    return { base, other, asked, read }
  })

describe("agents reading outside the repository", () => {
  test("Always allow saves the other repository's folder; later reads in it do not ask", async () => {
    const t = await Effect.runPromise(setup(["always"]))
    expect(await t.read(join(t.other, "src", "vm", "grid.ts"))).toMatchObject({ _tag: "Success" })
    expect(t.asked[0]!.question).toContain(join(t.other, "src", "vm", "grid.ts"))
    expect(t.asked[0]!.options.map((o) => o.label)).toEqual(["Allow once", `Always allow ${t.other}`, "Deny"])
    expect(await t.read(join(t.other, "src"))).toMatchObject({ _tag: "Success" })
    expect(t.asked.length).toBe(1)
  })

  test("Allow once lets this read through and asks again next time; Deny refuses", async () => {
    const t = await Effect.runPromise(setup(["once", "deny"]))
    const f = join(t.other, "src", "vm", "grid.ts")
    expect(await t.read(f)).toMatchObject({ _tag: "Success" })
    expect(await t.read(f)).toMatchObject({ _tag: "Failure", failure: { _tag: "NotAllowed" } })
    expect(t.asked.length).toBe(2)
  })

  test("zarg's own files, git internals, keys and env files are never readable, and nobody is asked", async () => {
    const t = await Effect.runPromise(setup(["always"]))
    for (const p of [join(t.base, "user", "grants.json"), join(t.other, ".git", "config"), join(t.base, ".ssh", "id_ed25519"), join(t.other, ".env.local")]) {
      expect(await t.read(p)).toMatchObject({ _tag: "Failure", failure: { _tag: "NotAllowed" } })
    }
    expect(t.asked.length).toBe(0)
  })

  test("reads that arrive together ask once; an Always allow answer lets the rest through", async () => {
    const t = await Effect.runPromise(setup(["always"]))
    const reads = await Promise.all([join(t.other, "src"), join(t.other, "src", "vm"), join(t.other, "src", "vm", "grid.ts")].map(t.read))
    expect(reads.map((r) => r._tag)).toEqual(["Success", "Success", "Success"])
    expect(t.asked.length).toBe(1)
  })
})
