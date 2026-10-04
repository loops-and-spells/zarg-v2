import { expect } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { answerLoads, command, journey, termOf, type Term, type World } from "../src"

/** The project's model: the live router (the full tier's). */
const liveModel = (w: World) => {
  mkdirSync(join(w.project, ".zarg"), { recursive: true })
  appendFileSync(join(w.project, ".zarg", "config.toml"), `\n[providers.zarg-router]\nbase_url = ${JSON.stringify(process.env.E2E_ZARG_ROUTER_URL ?? "http://localhost:11435/api/v1")}\n\n[roles]\ndefault = "zarg-router:deepseek-v4.1-flash-exl3"\n`)
}
/** Waits up to `ms` for `check` to hold. */
const eventually = async <A>(ms: number, check: () => A | undefined): Promise<A | undefined> => {
  const until = Date.now() + ms
  for (;;) {
    const a = check()
    if (a !== undefined || Date.now() > until) return a
    await Bun.sleep(2_000)
  }
}
/** The plans on the Backlog lane, as the backlog keeps them. */
const plans = (w: World) => {
  const dir = join(w.project, ".zarg", "backlog")
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; status: string; serves?: string }) : []
}

/** Opens a nav view from the rail (alt+a): the nav items sit above the agents. */
const openNav = async (t: Term, label: string) => {
  const on = () => t.screen().split("\n").some((l) => l.slice(0, 23).includes("▍") && l.slice(0, 23).includes(label))
  t.press("alt+a")
  await Bun.sleep(300)
  for (let k = 0; k < 8 && !on(); k++) {
    t.press("up")
    await Bun.sleep(200)
  }
  expect(on()).toBe(true)
  t.press("enter")
}

journey("J-0007", { tier: "fast" }, (proves) => {
  proves("S-0099", async (s) => {
    // An intent, as the Driver Agent would keep it.
    const call = async (tool: string, params: unknown) => {
      const r = await s.cli(["tool", "call", `gherkin/${tool}`, JSON.stringify(params)])
      expect(r.code).toBe(0)
      return r
    }
    await call("add-intent", { title: "A todo app for families", status: "accepted" })
    await call("add-outcome", { intent: "I-0001", text: "Each family member sees the chores assigned to them." })
    await call("ask-question", { intent: "I-0001", text: "Do children need their own login?" })
    const t = await s.open()
    await answerLoads(t)
    t.press("esc")
    await t.waitGone("esc closes", 10_000)
    await openNav(t, "Intents")
    s.note("buffer", "screen", t.screen())
    await t.waitFor("I-0001 A todo app for families", 10_000)
    // Its statements under it (cut to the column), the outcome and the open question.
    expect(t.screen()).toMatch(/▸ Each family member/)
    expect(t.screen()).toMatch(/\? Do children need/)
  })

  proves("S-0100", async (s) => {
    const t = termOf(s.term, "S-0100")
    // On the intent's row, a adds an outcome.
    t.press("a")
    await t.waitFor("⏎ save", 5_000)
    // (The line starts with the row's own text: cleared first.)
    t.type("\x7f".repeat(80))
    t.type("Chores repeat weekly without retyping.")
    t.press("enter")
    await t.waitFor("▸ Chores repeat week", 10_000)
    const render = await s.cli(["render", "--focus", "I-0001"])
    s.note("buffer", "zarg render --focus I-0001", render.out)
    expect(render.out).toContain("Outcome    Chores repeat weekly without retyping.")
  })

  proves("S-0101", async (s) => {
    const t = termOf(s.term, "S-0101")
    for (let k = 0; k < 6 && !/▍\s*\? Do children/.test(t.screen()); k++) {
      t.press("down")
      await Bun.sleep(200)
    }
    expect(t.screen()).toMatch(/▍\s*\? Do children/)
    t.press("enter")
    await t.waitFor("⏎ save", 5_000)
    t.type("\x7f".repeat(80))
    t.type("No, a parent's login covers them.")
    t.press("enter")
    await t.waitGone(/\? Do children need.*open/, 10_000)
    const render = await s.cli(["render", "--focus", "I-0001"])
    s.note("buffer", "zarg render --focus I-0001", render.out)
    expect(render.out).toMatch(/Do children need their own login\?.*answered: No, a parent's login covers them\./)
  })

  proves(
    "S-0102",
    async (s) => {
      liveModel(s.w)
      await termOf(s.term, "S-0102").exit()
      const t = await s.open()
      // YOLO: every plugin (the Intent Agent, the backlog) loads without asking.
      await command(t, "/yolo on")
      t.press("alt+m")
      await Bun.sleep(300)
      await command(t, "The app also lets parents reward finished chores with points. Keep that as an outcome.")
      const kept = await eventually(240_000, () => {
        const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "..", "cli", "src", "main.ts"), "render", "--focus", "I-0001"], { cwd: s.w.project, env: s.w.env }).stdout.toString()
        return /Outcome .*point/i.test(r) ? r : undefined
      })
      s.note("buffer", "zarg render --focus I-0001", kept ?? "(no outcome about points)")
      expect(kept).toBeDefined()
    },
    { model: true },
  )

  proves(
    "S-0103",
    async (s) => {
      // The Intent Agent drafts the outcomes no journey serves into plans that wait in Backlog.
      const planned = await eventually(300_000, () => plans(s.w).find((p) => p.status === "backlog" && p.serves !== undefined))
      s.note("buffer", "the plan", JSON.stringify(planned ?? null, null, 2))
      expect(planned).toBeDefined()
    },
    { model: true, timeoutMs: 330_000 },
  )

  proves(
    "S-0104",
    async (s) => {
      // An outcome against a constraint of the same intent: nothing can serve both.
      await s.cli(["tool", "call", "gherkin/add-constraint", JSON.stringify({ intent: "I-0001", text: "Chores never leave the family's own phone." })])
      await s.cli(["tool", "call", "gherkin/add-outcome", JSON.stringify({ intent: "I-0001", text: "Grandparents see every chore from any web browser." })])
      const asked = await eventually(300_000, () => {
        const dir = join(s.w.project, ".zarg", "inbox")
        if (!existsSync(dir)) return undefined
        return readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { title: string; state: string; from: { plugin: string } })
          .find((x) => x.from.plugin === "intent" && x.state === "open")
      })
      s.note("buffer", "the inbox topic", JSON.stringify(asked ?? null, null, 2))
      expect(asked).toBeDefined()
    },
    { model: true, timeoutMs: 330_000 },
  )
})
