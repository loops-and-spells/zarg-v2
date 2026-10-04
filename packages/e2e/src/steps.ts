import { expect } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Step } from "./proof"
import type { Term } from "./term"
import type { World } from "./world"

/** A slash command, typed as the operator types it. */
export const command = async (t: Term, text: string) => {
  t.type(text)
  await t.waitFor(text, 5_000)
  t.press("enter")
}

/** Answers each plugin's load question: Allow for `allow`, Not now for the rest, until none is left; the plugins that asked. */
export const answerLoads = async (t: Term, allow?: string) => {
  const asked: Array<string> = []
  const until = Date.now() + 30_000
  for (let quiet = 0; quiet < 4 && Date.now() < until; ) {
    await Bun.sleep(400)
    const m = /Plugin (\S+) wants to load/.exec(t.screen())
    if (m !== null && t.screen().includes("Not now")) {
      quiet = 0
      asked.push(m[1]!)
      // Done when this question is gone (the next one may show the same options at once).
      await t.choose(m[1] === allow ? "Allow" : "Not now", "right", `Plugin ${m[1]} wants to load`)
    } else quiet++
  }
  return asked
}

/** The fixture plugin's source (`zarg plugin build` it, then `zarg plugin add` its dist). */
export const PROBE = join(import.meta.dir, "..", "fixtures", "probe")

/** The terminal an earlier step opened (a step that goes on in the same session). */
export const termOf = (t: Term | undefined, id: string) => {
  if (t === undefined) throw new Error(`${id} runs in the session an earlier step opened, and none is open`)
  return t
}

/** Opens a nav view (Intents, Feedback, Backlog, …) from the rail (alt+a): the nav items sit above the agents. */
export const openNav = async (t: Term, label: string) => {
  const on = () => t.screen().split("\n").some((l) => l.slice(0, 23).includes("▍") && l.slice(0, 23).includes(label))
  t.press("alt+a")
  await Bun.sleep(300)
  for (let k = 0; k < 10 && !on(); k++) {
    t.press("up")
    await Bun.sleep(200)
  }
  expect(on()).toBe(true)
  t.press("enter")
}

/** A small graph: one journey ("Assign chores") of two scenarios (S-0001, S-0002), added through the CLI as a CLI actor would. */
export const choresGraph = async (s: Step) => {
  const call = async (tool: string, params: unknown) => {
    const r = await s.cli(["tool", "call", `gherkin/${tool}`, JSON.stringify(params)])
    if (r.code !== 0) throw new Error(`${tool}: ${r.err}`)
  }
  await call("add-persona", { name: "Parent", kind: "human", text: "A parent who assigns chores to the family." })
  await call("add-journey", { name: "Assign chores" })
  await call("add-scenario", { title: "Parent assigns a chore", when: "the parent assigns a chore to a child", by: [{ name: "Parent" }], arrives: { text: "the parent sees the family's chores" }, then: [{ text: "the child sees the new chore" }] })
  await call("add-scenario", { title: "Parent removes a chore", when: "the parent removes a chore", by: [{ name: "Parent" }], arrives: { text: "the parent sees the family's chores" }, then: [{ text: "the chore leaves every list" }] })
  for (const id of ["S-0001", "S-0002"]) await call("link", { scenario: id, edge: "in", journey: { name: "Assign chores" } })
}

/** The project's model: the live router (the full tier's). Written once: a model step's retry runs again in the same world. */
export const liveModel = (w: World) => {
  const file = join(w.project, ".zarg", "config.toml")
  if (existsSync(file) && readFileSync(file, "utf8").includes("[providers.zarg-router]")) return
  mkdirSync(join(w.project, ".zarg"), { recursive: true })
  appendFileSync(file, `\n[providers.zarg-router]\nbase_url = ${JSON.stringify(process.env.E2E_ZARG_ROUTER_URL ?? "http://localhost:11435/api/v1")}\n\n[roles]\ndefault = "zarg-router:deepseek-v4.1-flash-exl3"\n`)
}

/** Quits the session an earlier step opened, when one is still open (a retry finds it gone). */
export const quit = async (t: Term | undefined) => {
  if (t !== undefined) await t.exit().catch(() => undefined)
}
