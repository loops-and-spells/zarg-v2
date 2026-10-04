import { expect } from "bun:test"
import { join } from "node:path"
import type { Term } from "./term"

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
      await t.choose(m[1] === allow ? "Allow" : "Not now")
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
