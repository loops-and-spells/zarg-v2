import { expect } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeProvider, journey, type Term } from "../src"

// A provider on the OpenRouter wire, with a key made up for this run: never a real one.
const KEY = `sk-or-e2e-${crypto.randomUUID()}`
const provider = fakeProvider({ key: KEY, models: ["e2e/one", "e2e/two"] })

/** A slash command, typed as the operator types it. */
const command = async (t: Term, text: string) => {
  t.type(text)
  await t.waitFor(text, 5_000)
  t.press("enter")
}
/** Sets the highlighted setting of the Log in table to `value` (its old value cleared). */
const setValue = async (t: Term, value: string) => {
  t.press("enter")
  await t.waitFor("⏎ save", 5_000)
  t.type("\x7f".repeat(60))
  t.type(value)
  t.press("enter")
  await t.waitGone("⏎ save", 5_000)
}
/** Answers Not now to each plugin's grant question until none is left; the plugins that asked. */
const notNow = async (t: Term) => {
  const asked = new Set<string>()
  const until = Date.now() + 30_000
  for (let quiet = 0; quiet < 3 && Date.now() < until; ) {
    await Bun.sleep(400)
    const m = /Plugin (\S+) wants to load/.exec(t.screen())
    if (m !== null && t.screen().includes("Not now")) {
      quiet = 0
      asked.add(m[1]!)
      await t.choose("Not now")
    } else quiet++
  }
  return [...asked]
}
/** Answers each plugin's load question: Allow for `allow`, Not now for the rest; the plugins that asked. */
const answerLoads = async (t: Term, allow: string) => {
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
const PROBE = join(import.meta.dir, "..", "fixtures", "probe")
const termOf = (t: Term | undefined, id: string) => {
  if (t === undefined) throw new Error(`${id} runs in the session an earlier step opened, and none is open`)
  return t
}

// Notes the probe plugin may read (once it asks), and a file it never declared.
const SEED = { "notes/a.md": "alpha\n", "notes/b.md": "beta\n", "notes/c.md": "gamma\n", "secrets.txt": "hidden\n" }

journey("J-0002", { tier: "fast", seed: SEED }, (proves) => {
  proves("S-0084", async (s) => {
    const t = await s.open()
    // First run, no model: the Setup sheet, every provider and whether it answers.
    await t.waitFor("not set up", 30_000)
    // (The sheet's scroll mark can sit over the count's first cell.)
    expect(t.screen()).toContain("providers ready · default: none")
  })

  proves("S-0069", async (s) => {
    const t = termOf(s.term, "S-0069")
    // Over the Setup sheet, the grant question of a plugin that reaches past the graph.
    await t.waitFor("wants to load", 10_000)
    expect(t.screen()).toMatch(/Plugin backlog wants to load/)
    // zarg's own plugins that only touch the graph started approved: they never ask.
    const agenda = (await s.cli(["agenda"])).json as ReadonlyArray<{ readonly id: string }>
    const grants = agenda.map((a) => a.id).filter((id) => id.startsWith("plugin-grant:"))
    s.note("buffer", "zarg agenda (the grants asked for)", grants.join("\n"))
    expect(grants).toContain("plugin-grant:backlog")
    for (const own of ["gherkin", "evidence-terminal", "evidence-screen"]) expect(grants).not.toContain(`plugin-grant:${own}`)
    // Not now, for each question, then the Setup sheet closes: wait until neither shows, and the screen has settled.
    const until = Date.now() + 30_000
    for (let quiet = 0; quiet < 3 && Date.now() < until; ) {
      await Bun.sleep(400)
      const screen = t.screen()
      if (screen.includes("Not now")) {
        quiet = 0
        await t.choose("Not now")
      } else if (screen.includes("esc closes")) {
        quiet = 0
        // An answered question gives the bar its keys first; Esc until the sheet is gone.
        t.press("esc")
      } else quiet++
    }
    expect(t.screen()).not.toContain("Not now")
    expect(t.screen()).not.toContain("esc closes")
    await t.waitFor("Nothing needs you", 10_000)
  })

  proves("S-0067", async (s) => {
    const t = termOf(s.term, "S-0067")
    await command(t, "/yolo on")
    await t.waitFor(/·\s*YOLO\s*·/, 10_000)
    // The status line says so (its notice, "YOLO is on…", is cut to the width).
    expect(t.screen().split("\n").at(-1)).toMatch(/·\s*YOLO\s*·.*YOLO is/)
  })

  proves("S-0070", async (s) => {
    const t = termOf(s.term, "S-0070")
    await command(t, "/yolo off")
    await t.waitGone(/·\s*YOLO\s*·/, 10_000)
    // The plugins the operator never approved ask again.
    await t.waitFor("wants to load", 15_000)
    const asked = await notNow(t)
    s.note("buffer", "plugins that asked again", asked.join("\n"))
    // None of them was ever approved (S-0069 said Not now to each).
    expect(asked.length).toBeGreaterThan(0)
  })

  proves("S-0086", async (s) => {
    const t = termOf(s.term, "S-0086")
    await command(t, "/login")
    await t.waitFor("providers ready", 10_000)
    expect(t.screen()).toContain("Providers")
  })

  proves("S-0026", async (s) => {
    const t = termOf(s.term, "S-0026")
    // openrouter: one row down; ⏎ logs in.
    for (let k = 0; k < 4 && !/┃ openrouter/.test(t.screen()); k++) {
      t.press("down")
      await Bun.sleep(150)
    }
    t.press("enter")
    await t.waitFor("OPENROUTER_API_KEY", 10_000)
    expect(t.screen()).toContain("OPENROUTER_URL")
    // The key, typed into the sensitive field: only dots show.
    t.press("]")
    await Bun.sleep(300)
    t.press("enter")
    await t.waitFor("⏎ save", 5_000)
    // (A wrong one: S-0028 is its refusal.)
    t.type("sk-or-e2e-wrong")
    await t.waitFor("•••••••••••••••", 5_000)
    expect(t.screen()).not.toContain("sk-or-e2e-wrong")
    t.press("enter")
    await t.waitGone("⏎ save", 5_000)
    // Saved, in the operator's own settings.
    const local = join(s.w.userDir, ".env.local")
    const until = Date.now() + 10_000
    while (Date.now() < until && !(existsSync(local) && /^OPENROUTER_API_KEY=/m.test(readFileSync(local, "utf8")))) await Bun.sleep(100)
    expect(readFileSync(local, "utf8")).toMatch(/^OPENROUTER_API_KEY=/m)
  })

  proves("S-0028", async (s) => {
    const t = termOf(s.term, "S-0028")
    t.press("down")
    await t.waitFor("┃ OPENROUTER_URL", 5_000)
    await setValue(t, provider.url)
    t.press("c")
    await t.waitFor("✗ the key was refused", 15_000)
    // The settings stay listed to fix.
    expect(t.screen()).toMatch(/Log in ─+[\s\S]*OPENROUTER_URL/)
  })

  proves("S-0027", async (s) => {
    const t = termOf(s.term, "S-0027")
    t.press("up")
    await t.waitFor("┃ OPENROUTER_API_KEY", 5_000)
    await setValue(t, KEY)
    t.press("c")
    await t.waitFor("✓ reachable · 2 models", 15_000)
    // The key is kept outside the project, and never as it was typed.
    const local = join(s.w.userDir, ".env.local")
    expect(existsSync(local)).toBe(true)
    expect(readFileSync(local, "utf8")).not.toContain(KEY)
    const inProject = Bun.spawnSync(["grep", "-rl", "--exclude-dir=.git", KEY, s.w.project]).stdout.toString()
    expect(inProject).toBe("")
    s.note("buffer", "~/.config/zarg/.env.local (the key's line, encrypted; its ciphertext cut)", readFileSync(local, "utf8").split("\n").filter((l) => l.startsWith("OPENROUTER_API_KEY")).join("\n").replace(/(varlock\("local:)[^"]*/, "$1…"))
  })

  proves("S-0034", async (s) => {
    const t = termOf(s.term, "S-0034")
    await t.waitFor("openrouter:e2e/one", 10_000)
    expect(t.screen()).toContain("openrouter:e2e/two")
  })

  proves("S-0035", async (s) => {
    const t = termOf(s.term, "S-0035")
    t.press("]")
    await Bun.sleep(300)
    t.press("enter")
    // The default, in the operator's own config.
    const config = join(s.w.userDir, "config.toml")
    const until = Date.now() + 10_000
    while (Date.now() < until && !(existsSync(config) && /openrouter:e2e\/one/.test(readFileSync(config, "utf8")))) await Bun.sleep(100)
    s.note("buffer", "~/.config/zarg/config.toml", readFileSync(config, "utf8"))
    expect(readFileSync(config, "utf8")).toMatch(/default\s*=\s*"openrouter:e2e\/one"/)
  })

  proves("S-0085", async (s) => {
    const t = termOf(s.term, "S-0085")
    // The driver answers now: the sheet closes on its own.
    await t.waitGone("providers ready", 15_000)
    expect(t.screen()).not.toContain("esc closes")
  })

  proves("S-0087", async (s) => {
    const t = termOf(s.term, "S-0087")
    await command(t, "/models")
    await t.waitFor("openrouter:e2e/one", 10_000)
    expect(t.screen()).toContain("default: openrouter:e2e/one")
    t.press("esc")
    await t.waitGone("providers ready", 10_000)
  })

  proves("S-0088", async (s) => {
    const t = termOf(s.term, "S-0088")
    const running = await s.cli(["core", "status"])
    s.note("buffer", "zarg core status (in the session)", running.out)
    expect(running.json).toMatchObject({ running: true, mode: "child" })
    expect(await t.exit()).toBe(0)
    const after = await s.cli(["core", "status"])
    s.note("buffer", "zarg core status (after quitting)", after.out)
    expect(after.json).toEqual({ running: false })
  })

  proves("S-0030", async (s) => {
    // The driver's provider stops answering; the next start opens Setup again.
    provider.stop()
    const t = await s.open()
    // The default is set, yet no provider answers: Setup is back.
    await t.waitFor("0 providers ready · default: openrouter:e2e/one", 30_000)
  })

  proves("S-0090", async (s) => {
    const second = await s.cli([])
    s.note("buffer", "zarg (a second session)", second.err)
    expect(second.code).not.toBe(0)
    expect(second.err).toContain("zarg --attach")
  })

  proves("S-0091", async (s) => {
    const first = termOf(s.term, "S-0091")
    const joined = await s.open(["--attach"])
    await joined.waitFor("providers ready", 30_000)
    // One core for both.
    expect((await s.cli(["core", "status"])).json).toMatchObject({ running: true, mode: "child" })
    await joined.exit()
    // The first session is still the core's.
    expect((await s.cli(["core", "status"])).json).toMatchObject({ running: true })
    await first.exit()
  })

  proves("S-0089", async (s) => {
    const t = await s.open()
    await t.waitFor("providers ready", 30_000)
    const left = (await s.cli(["core", "status"])).json as { readonly pid: number }
    // The session is gone, its core still holds the project: paused, so it cannot notice and quit.
    process.kill(left.pid, "SIGSTOP")
    await t.kill()
    const next = await s.open([], { keepCore: true })
    await next.waitFor("providers ready", 30_000)
    const now = (await s.cli(["core", "status"])).json as { readonly pid: number }
    s.note("buffer", "zarg core status (the core replaced)", `left behind: ${left.pid}\nnow: ${now.pid}`)
    expect(now.pid).not.toBe(left.pid)
    let gone = false
    try {
      process.kill(left.pid, 0)
    } catch {
      gone = true
    }
    if (!gone) process.kill(left.pid, "SIGKILL")
    expect(gone).toBe(true)
  })

  proves("S-0060", async (s) => {
    // A third-party plugin, built and published with an install script.
    const built = await s.cli(["plugin", "build", PROBE])
    expect(built.code).toBe(0)
    const dist = join(PROBE, "dist")
    const marker = join(s.w.home, "install-script-ran")
    writeFileSync(join(dist, "package.json"), JSON.stringify({ name: "probe", scripts: { postinstall: `touch ${marker}`, preinstall: `touch ${marker}` } }))
    const added = await s.cli(["plugin", "add", dist])
    s.note("buffer", "zarg plugin add", added.out + added.err)
    expect(added.json).toMatchObject({ installed: "probe" })
    expect(existsSync(marker)).toBe(false)
    // It waits for the operator: listed in the project, never yet approved.
    writeFileSync(join(s.w.project, ".zarg", "config.toml"), `[plugins.probe]\nsource = ${JSON.stringify(dist)}\n`)
    expect(String((added.json as { next: string }).next)).toContain("approve it")
  })

  proves("S-0061", async (s) => {
    s.term !== undefined && (await s.term.exit())
    const t = await s.open()
    const asked = await answerLoads(t, "probe")
    s.note("buffer", "plugins that asked to load", asked.join("\n"))
    expect(asked).toContain("probe")
    const grants = JSON.parse(readFileSync(join(s.w.userDir, "grants.json"), "utf8"))
    expect(grants[s.w.project]?.probe?.digests?.length).toBe(1)
    // Only what it declared: no extra grant yet.
    expect(grants[s.w.project]?.probe?.extra).toBeUndefined()
    // The Setup sheet (no provider answers) gives the keys back on Esc.
    t.press("esc")
    await t.waitGone("esc closes", 10_000)
  })

  proves("S-0062", async (s) => {
    const t = termOf(s.term, "S-0062")
    await command(t, "/peek a")
    await t.waitFor("Plugin probe wants to read", 15_000)
    expect(t.screen()).toMatch(/notes\/a\.md/)
    expect(t.screen()).toMatch(/Always\s+Deny/)
  })

  proves("S-0063", async (s) => {
    const t = termOf(s.term, "S-0063")
    await t.choose("Allow")
    await t.waitFor("note: alpha", 10_000)
  })

  proves("S-0064", async (s) => {
    const t = termOf(s.term, "S-0064")
    await command(t, "/peek b")
    await t.waitFor(/Plugin probe wants to read[\s\S]*b\.md/, 15_000)
    await t.choose("Always")
    await t.waitFor("note: beta", 10_000)
    const extra = JSON.parse(readFileSync(join(s.w.userDir, "grants.json"), "utf8"))[s.w.project]?.probe?.extra
    s.note("buffer", "grants.json (probe's saved grants)", JSON.stringify(extra, null, 2))
    expect(extra).toEqual([{ kind: "fs-read", glob: join(s.w.project, "notes", "b.md") }])
  })

  proves("S-0065", async (s) => {
    const t = termOf(s.term, "S-0065")
    await command(t, "/peek c")
    await t.waitFor(/Plugin probe wants to read[\s\S]*c\.md/, 15_000)
    await t.choose("Deny")
    await t.waitFor("refused: denied", 10_000)
    expect(t.screen()).not.toContain("gamma")
  })

  proves("S-0066", async (s) => {
    const t = termOf(s.term, "S-0066")
    await command(t, "/escape")
    await t.waitFor("undeclared", 10_000)
    expect(t.screen()).not.toContain("hidden")
    expect(t.screen()).not.toContain("wants to read")
  })

  proves("S-0068", async (s) => {
    const t = termOf(s.term, "S-0068")
    for (let i = 0; i < 3; i++) {
      await command(t, "/spin")
      await Bun.sleep(1_500)
    }
    // The inbox says it stopped, and why.
    await t.waitFor("Plugin probe was disabled after 3 restarts", 15_000)
  })
})
