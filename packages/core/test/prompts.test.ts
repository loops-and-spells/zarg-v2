import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { makeLog } from "../src/log"
import { makePrompts, PROMPT, PROMPT_DONE } from "../src/prompts"

const q = { question: "Plugin tracker wants to reach a.test.", options: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }], allowOther: false, kind: "grant" as const }
const open = () => Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-prompts-")), (t) => t))
const customs = (log: Awaited<ReturnType<typeof open>>) => log.all().filter((e) => e.type === "CUSTOM").map((e) => ({ name: e.name, value: e.value as Record<string, unknown> }))

describe("prompts", () => {
  test("two prompts wait side by side; each is answered by its id, in any order", async () => {
    const log = await open()
    const p = makePrompts(log)
    const a = Effect.runFork(p.ask(q))
    const b = Effect.runFork(p.ask({ ...q, question: "Plugin tracker wants to reach b.test." }))
    await Bun.sleep(10)
    const [ida, idb] = customs(log).filter((c) => c.name === PROMPT).map((c) => String(c.value.id))
    expect(await Effect.runPromise(p.answer(idb!, { choice: "deny" }))).toEqual({ notice: "answered" })
    expect(await Effect.runPromise(Fiber.join(b))).toEqual({ choice: "deny" })
    await Effect.runPromise(p.answer(ida!, { choice: "once" }))
    expect(await Effect.runPromise(Fiber.join(a))).toEqual({ choice: "once" })
    expect(customs(log).filter((c) => c.name === PROMPT_DONE).map((c) => c.value.id)).toEqual([idb, ida])
  })
  test("an answer to a prompt no one waits for says so", async () => {
    const p = makePrompts(await open())
    expect(await Effect.runPromise(p.answer("prompt-nope", { choice: "once" }))).toEqual({ notice: "that question is no longer open" })
  })
  test("an asker that goes away withdraws its prompt", async () => {
    const log = await open()
    const f = Effect.runFork(makePrompts(log).ask(q))
    await Bun.sleep(10)
    await Effect.runPromise(Fiber.interrupt(f))
    expect(customs(log).at(-1)).toMatchObject({ name: PROMPT_DONE, value: { withdrawn: true } })
  })
  test("a restarted core withdraws prompts the last one left open", async () => {
    const log = await open()
    Effect.runFork(makePrompts(log).ask(q))
    await Bun.sleep(10)
    await Effect.runPromise(makePrompts(log).closeStale)
    const id = customs(log).find((c) => c.name === PROMPT)!.value.id
    expect(customs(log).at(-1)).toEqual({ name: PROMPT_DONE, value: { id, withdrawn: true } })
  })
})
