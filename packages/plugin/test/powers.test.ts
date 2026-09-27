import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { type Ask, isPower, makeGrants, makePowers, scopesDigest, secretVar, served, warnings } from "../src/runtime"

const tmp = () => mkdtempSync(join(tmpdir(), "zt-powers-"))
const vaultOf = (values: Record<string, string>) => (name: string) => Effect.succeed(values[name] !== undefined ? Redacted.make(values[name]!) : undefined)

const setup = (opts: { scopes?: object; optional?: object; answers?: Array<"once" | "folder" | "always" | "deny">; yolo?: boolean; vault?: Record<string, string>; fetchImpl?: typeof fetch; userDir?: string }) =>
  Effect.gen(function* () {
    const file = join(tmp(), "grants.json")
    const grants = yield* makeGrants({ file, project: "/p" })
    const scopes = (opts.scopes ?? {}) as never
    const optional = (opts.optional ?? {}) as never
    const digest = scopesDigest(scopes, optional)
    yield* grants.approveLoad("tracker", digest)
    const asked: Array<string> = []
    const logs: Array<string> = []
    const answers = [...(opts.answers ?? [])]
    const ask: Ask = (q) => Effect.sync(() => { asked.push(q.what); return answers.shift() ?? "deny" })
    const powers = makePowers({
      plugin: "tracker", manifest: { scopes, optional }, grants, digest, vault: vaultOf(opts.vault ?? {}), config: {},
      ask, yolo: () => opts.yolo === true, log: (l) => logs.push(l), redact: (t) => t.replaceAll("zt-secret-value", "<redacted>"),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      ...(opts.userDir ? { userDir: opts.userDir } : {}),
    })
    return { powers, asked, logs, grants, file }
  })

const go = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

describe("secrets", () => {
  test("a granted key of its own namespace; nothing else", async () => {
    const vault = { [secretVar("tracker", "TOKEN")]: "zt-own", [secretVar("other", "TOKEN")]: "zt-other" }
    const { powers } = await go(setup({ scopes: { secrets: ["TOKEN"] }, vault }))
    expect(await powers["secrets.get"]!({ name: "TOKEN" })).toBe("zt-own")
    await expect(powers["secrets.get"]!({ name: "OTHER" })).rejects.toMatchObject({ tag: "NotGranted" })
    await expect(powers["secrets.get"]!({ name: "../other.TOKEN" })).rejects.toMatchObject({ tag: "NotGranted" })
  })
  test("secretVar maps the namespace to one variable name", () => {
    expect(secretVar("open-router", "API_KEY")).toBe("ZARG_PLUGIN_OPEN_ROUTER__API_KEY")
  })
})

describe("net", () => {
  const recording = () => {
    const seen: Array<string> = []
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url))
      if (String(url) === "https://a.test/redirect") return new Response("", { status: 302, headers: { location: "https://evil.test/x" } })
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
    }) as typeof fetch
    return { seen, f }
  }
  test("https to a granted host; user@host and other hosts are refused; plain data back", async () => {
    const { seen, f } = recording()
    const { powers } = await go(setup({ scopes: { net: ["a.test"] }, fetchImpl: f }))
    expect(await powers.fetch!({ url: "https://a.test/x" })).toEqual({ status: 200, headers: { "content-type": "text/plain" }, text: "ok" })
    await expect(powers.fetch!({ url: "https://a.test@evil.test/x" })).rejects.toMatchObject({ tag: "NotGranted" })
    await expect(powers.fetch!({ url: "http://a.test/x" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(seen).toEqual(["https://a.test/x"])
  })
  test("a redirect to an ungranted host is refused", async () => {
    const { seen, f } = recording()
    const { powers } = await go(setup({ scopes: { net: ["a.test"] }, fetchImpl: f }))
    await expect(powers.fetch!({ url: "https://a.test/redirect" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(seen).toEqual(["https://a.test/redirect"])
  })
})

describe("files", () => {
  test("a granted glob reads; .. and a symlink out of it are refused", async () => {
    const root = tmp()
    mkdirSync(join(root, "data"))
    writeFileSync(join(root, "data", "a.txt"), "inside")
    writeFileSync(join(root, "secret.txt"), "outside")
    symlinkSync(join(root, "secret.txt"), join(root, "data", "link.txt"))
    const { powers } = await go(setup({ scopes: { fs: { read: [`${root}/data/**`] } } }))
    expect(await powers["fs.read"]!({ path: `${root}/data/a.txt` })).toBe("inside")
    await expect(powers["fs.read"]!({ path: `${root}/data/../secret.txt` })).rejects.toMatchObject({ tag: "NotGranted" })
    await expect(powers["fs.read"]!({ path: `${root}/data/link.txt` })).rejects.toMatchObject({ tag: "NotGranted" })
  })
})

describe("grants on demand", () => {
  test("an optional host asks once; once allows only that call; always persists", async () => {
    const f = (async () => new Response("ok")) as unknown as typeof fetch
    const s = await go(setup({ optional: { net: ["b.test"] }, answers: ["once", "always"], fetchImpl: f }))
    expect((await s.powers.fetch!({ url: "https://b.test/1" }) as { status: number }).status).toBe(200)
    expect((await s.powers.fetch!({ url: "https://b.test/2" }) as { status: number }).status).toBe(200)
    expect((await s.powers.fetch!({ url: "https://b.test/3" }) as { status: number }).status).toBe(200)
    expect(s.asked).toHaveLength(2)
  })
  test("an \"ask\" fs kind names the concrete path; folder grants the directory", async () => {
    const root = tmp()
    writeFileSync(join(root, "one.txt"), "1")
    writeFileSync(join(root, "two.txt"), "2")
    const s = await go(setup({ optional: { fs: { read: "ask" } }, answers: ["folder"] }))
    expect(await s.powers["fs.read"]!({ path: join(root, "one.txt") })).toBe("1")
    expect(await s.powers["fs.read"]!({ path: join(root, "two.txt") })).toBe("2")
    expect(s.asked).toEqual([`read ${join(root, "one.txt")}`])
  })
  test("an undeclared scope never asks", async () => {
    const s = await go(setup({ answers: ["always"] }))
    await expect(s.powers.fetch!({ url: "https://c.test/" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(s.asked).toEqual([])
  })
  test("concurrent calls share one question and time out together", async () => {
    const f = (async () => new Response("ok")) as unknown as typeof fetch
    let questions = 0
    const file = join(tmp(), "grants.json")
    const r = await go(Effect.gen(function* () {
      const grants = yield* makeGrants({ file, project: "/p" })
      const digest = scopesDigest({}, { net: ["b.test"] })
      yield* grants.approveLoad("tracker", digest)
      const powers = makePowers({
        plugin: "tracker", manifest: { scopes: {}, optional: { net: ["b.test"] } }, grants, digest, vault: vaultOf({}), config: {},
        ask: () => Effect.andThen(Effect.sync(() => void questions++), Effect.never), askTimeoutMs: 200,
        yolo: () => false, log: () => {}, redact: (t) => t, fetch: f,
      })
      return yield* Effect.promise(() => Promise.allSettled([powers.fetch!({ url: "https://b.test/1" }), powers.fetch!({ url: "https://b.test/2" })]))
    }))
    expect(questions).toBe(1)
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"])
  })
})

describe("YOLO", () => {
  test("YOLO passes only declared scopes and writes no grants", async () => {
    const f = (async () => new Response("ok")) as unknown as typeof fetch
    const s = await go(setup({ optional: { net: ["b.test"] }, yolo: true, fetchImpl: f }))
    expect((await s.powers.fetch!({ url: "https://b.test/1" }) as { status: number }).status).toBe(200)
    await expect(s.powers.fetch!({ url: "https://undeclared.test/" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(s.asked).toEqual([])
    expect(s.logs.some((l) => l.includes("yolo: tracker net b.test"))).toBe(true)
    expect((await go(s.grants.of("tracker", "x"))).extra).toEqual([])
  })
})

describe("secrets in errors", () => {
  test("a secret inside a plugin error is redacted", async () => {
    const { powers, logs } = await go(setup({}))
    await powers["console.log"]!("token is zt-secret-value")
    expect(logs.join("\n")).not.toContain("zt-secret-value")
  })
})

describe("warnings", () => {
  test("graph read plus a host warns that data can leave", () => {
    expect(warnings({ graph: "read", net: ["x.test"] }, {})).toEqual(["can read your graph and send it to x.test"])
    expect(warnings({ secrets: ["K"] }, { net: "ask" })).toEqual(["holds a secret and may ask to reach any host"])
    // A dependency on a graph plugin reads the graph through it.
    expect(warnings({ net: ["x.test"] }, {}, ["gherkin"])).toEqual(["can read your graph and send it to x.test"])
  })
})

describe("review fixes: files", () => {
  test("a write through a symlink leaves the target untouched; a symlinked parent creates nothing outside", async () => {
    const root = tmp()
    mkdirSync(join(root, "proj", "out"), { recursive: true })
    mkdirSync(join(root, "secret"))
    writeFileSync(join(root, "secret", "keep.txt"), "precious")
    symlinkSync(join(root, "secret", "keep.txt"), join(root, "proj", "out", "report.md"))
    symlinkSync(join(root, "secret"), join(root, "proj", "linkdir"))
    const { powers } = await go(setup({ scopes: { fs: { write: [`${root}/proj/**`] } } }))
    await expect(powers["fs.write"]!({ path: `${root}/proj/out/report.md`, text: "x" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(readFileSync(join(root, "secret", "keep.txt"), "utf8")).toBe("precious")
    await expect(powers["fs.write"]!({ path: `${root}/proj/linkdir/new.txt`, text: "x" })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(existsSync(join(root, "secret", "new.txt"))).toBe(false)
    expect(await powers["fs.write"]!({ path: `${root}/proj/out/fine.md`, text: "ok" })).toBe(null)
    expect(readFileSync(join(root, "proj", "out", "fine.md"), "utf8")).toBe("ok")
  })
  test("concurrent writes of one file leave one whole text, never a mix", async () => {
    const root = tmp()
    mkdirSync(join(root, "proj"), { recursive: true })
    const { powers } = await go(setup({ scopes: { fs: { write: [`${root}/proj/**`] } } }))
    const texts = Array.from({ length: 40 }, (_, i) => `${i}:`.padEnd(((i * 7919) % 40) * 1000 + 10, String(i % 10)))
    await Promise.all(texts.map((text) => powers["fs.write"]!({ path: `${root}/proj/r.json`, text })))
    expect(texts).toContain(readFileSync(join(root, "proj", "r.json"), "utf8"))
  })
  test("zarg's trust state, git internals, bunfig and env files stay out of reach even when granted", async () => {
    const root = tmp()
    mkdirSync(join(root, ".git", "hooks"), { recursive: true })
    const { powers } = await go(setup({ scopes: { fs: { read: [`${root}/**`], write: [`${root}/**`] } }, userDir: join(root, "zuser") }))
    for (const p of [".git/hooks/pre-commit", "bunfig.toml", ".env.local", ".zarg/config.toml", "zuser/grants.json"]) {
      await expect(powers["fs.write"]!({ path: join(root, p), text: "x" })).rejects.toMatchObject({ tag: "NotGranted" })
    }
  })
  test("a FIFO or a file over the size cap is refused instead of stalling the core", async () => {
    const root = tmp()
    Bun.spawnSync(["mkfifo", join(root, "pipe")])
    writeFileSync(join(root, "big.txt"), "x".repeat(11 * 1024 * 1024))
    const { powers } = await go(setup({ scopes: { fs: { read: [`${root}/**`] } } }))
    await expect(powers["fs.read"]!({ path: join(root, "pipe") })).rejects.toMatchObject({ tag: "PluginError" })
    await expect(powers["fs.read"]!({ path: join(root, "big.txt") })).rejects.toMatchObject({ tag: "PluginError" })
  })
  test("with HOME unset a ~/ grant matches nothing instead of the whole disk", async () => {
    const home = process.env.HOME
    delete process.env.HOME
    try {
      const { powers } = await go(setup({ scopes: { fs: { read: ["~/**"] } } }))
      await expect(powers["fs.read"]!({ path: "/etc/hostname" })).rejects.toMatchObject({ tag: "NotGranted" })
    } finally {
      process.env.HOME = home
    }
  })
})

describe("review fixes: secrets and questions", () => {
  test("secret keys cannot collide across namespaces", async () => {
    const { powers } = await go(setup({ scopes: { secrets: ["SYNC__TOKEN", "_X", "Y_"] } }))
    for (const name of ["SYNC__TOKEN", "_X", "Y_"]) await expect(powers["secrets.get"]!({ name })).rejects.toMatchObject({ tag: "NotGranted" })
    expect(() => secretVar("acme--sync", "TOKEN")).toThrow()
  })
  test("a late answer still counts: always given after the call timed out is saved", async () => {
    const f = (async () => new Response("ok")) as unknown as typeof fetch
    let answer!: (a: "always") => void
    const file = join(tmp(), "grants.json")
    const r = await go(Effect.gen(function* () {
      const grants = yield* makeGrants({ file, project: "/p" })
      const digest = scopesDigest({}, { net: ["b.test"] })
      yield* grants.approveLoad("tracker", digest)
      const powers = makePowers({
        plugin: "tracker", manifest: { scopes: {}, optional: { net: ["b.test"] } }, grants, digest, vault: vaultOf({}), config: {},
        ask: () => Effect.promise(() => new Promise<"always">((res) => (answer = res))), askTimeoutMs: 50,
        yolo: () => false, log: () => {}, redact: (t) => t, fetch: f,
      })
      const first = yield* Effect.promise(() => powers.fetch!({ url: "https://b.test/1" }).then(() => "ok", (e) => e.tag))
      answer("always")
      yield* Effect.sleep(20)
      return { first, extra: (yield* grants.of("tracker", digest)).extra }
    }))
    expect(r.first).toBe("NotGranted")
    expect(r.extra).toEqual([{ kind: "net", host: "b.test" }])
  })
  test("one plugin has one question open at a time; others fail at once", async () => {
    const f = (async () => new Response("ok")) as unknown as typeof fetch
    let asked = 0
    const file = join(tmp(), "grants.json")
    const r = await go(Effect.gen(function* () {
      const grants = yield* makeGrants({ file, project: "/p" })
      const digest = scopesDigest({}, { net: "ask" })
      yield* grants.approveLoad("tracker", digest)
      const powers = makePowers({
        plugin: "tracker", manifest: { scopes: {}, optional: { net: "ask" } }, grants, digest, vault: vaultOf({}), config: {},
        ask: () => Effect.andThen(Effect.sync(() => void asked++), Effect.never), askTimeoutMs: 100,
        yolo: () => false, log: () => {}, redact: (t) => t, fetch: f,
      })
      return yield* Effect.promise(() => Promise.allSettled([powers.fetch!({ url: "https://a.test/" }), powers.fetch!({ url: "https://b.test/" }), powers.fetch!({ url: "https://c.test/" })]))
    }))
    expect(asked).toBe(1)
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected", "rejected"])
  })
  test("question text cannot carry control characters", async () => {
    const root = tmp()
    const s = await go(setup({ optional: { fs: { read: "ask" } }, answers: ["deny"] }))
    await s.powers["fs.read"]!({ path: `${root}/a\n\u001b[2Jevil.txt` }).catch(() => {})
    expect(s.asked[0]).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
  test("the host learns every secret value it served, to scrub it from what the plugin returns", async () => {
    const vault = { [secretVar("tracker", "TOKEN")]: "zt-served-value" }
    const { powers } = await go(setup({ scopes: { secrets: ["TOKEN"] }, vault }))
    await powers["secrets.get"]!({ name: "TOKEN" })
    expect([...served(powers)]).toEqual(["zt-served-value"])
  })
  test("a power name that is not a power (inherited ones included) is not one", () => {
    expect(isPower({ fetch: async () => 1 } as never, "hasOwnProperty")).toBe(false)
    expect(isPower({ fetch: async () => 1 } as never, "__proto__")).toBe(false)
    expect(isPower({ fetch: async () => 1 } as never, "fetch")).toBe(true)
  })
})


describe("plugins.call", () => {
  test("reaches only declared dependencies, and only the methods their contract lists", async () => {
    const calls: Array<string> = []
    const powers = makePowers({
      plugin: "user", manifest: { scopes: {} as never, optional: {} as never }, grants: Effect.runSync(makeGrants({ file: join(tmp(), "g.json"), project: "/zt/p" })), digest: "d",
      vault: () => Effect.succeed(undefined), config: {}, ask: () => Effect.succeed("deny"), yolo: () => false, log: () => {}, redact: (t) => t,
      dependencies: [{ name: "base", methods: ["hello"] }],
      callPlugin: async (name, method) => (calls.push(`${name}.${method}`), "ok"),
    })
    expect(await powers["plugins.call"]!({ name: "base", method: "hello", params: {} })).toBe("ok")
    await expect(powers["plugins.call"]!({ name: "base", method: "write", params: {} })).rejects.toThrow("not in the base contract")
    await expect(powers["plugins.call"]!({ name: "other", method: "hello", params: {} })).rejects.toThrow("not one of its pluginDependencies")
    expect(calls).toEqual(["base.hello"])
  })
})

describe("project-relative files", () => {
  test("relative paths and globs are the project's; a write creates missing folders inside its grant; outside stays refused", async () => {
    const project = tmp()
    writeFileSync(join(project, "notes.md"), "hello")
    const grants = Effect.runSync(makeGrants({ file: join(tmp(), "g.json"), project }))
    // A granted load: declared scopes pass without a question.
    await Effect.runPromise(grants.approveLoad("svc", "d"))
    const powers = makePowers({
      plugin: "svc", manifest: { scopes: { fs: { read: ["intent/**", ".zarg/out/**", "notes.md"], write: [".zarg/out/**"] } } as never, optional: {} as never },
      grants, digest: "d",
      vault: () => Effect.succeed(undefined), config: {}, ask: () => Effect.succeed("deny"), yolo: () => false, log: () => {}, redact: (t) => t,
      projectRoot: project,
    })
    expect(await powers["fs.read"]!({ path: "notes.md" }).catch((e: Error) => e.message)).toBe("hello")
    await powers["fs.write"]!({ path: ".zarg/out/run/r-1.json", text: "{}" })
    expect(readFileSync(join(project, ".zarg/out/run/r-1.json"), "utf8")).toBe("{}")
    expect(await powers["fs.list"]!({ dir: ".zarg/out/run" })).toEqual(["r-1.json"])
    await expect(powers["fs.write"]!({ path: "elsewhere.txt", text: "x" })).rejects.toThrow()
  })
})
