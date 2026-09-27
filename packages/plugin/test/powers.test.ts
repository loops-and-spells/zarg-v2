import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { type Ask, makeGrants, makePowers, scopesDigest, secretVar, warnings } from "../src/runtime"

const tmp = () => mkdtempSync(join(tmpdir(), "zt-powers-"))
const vaultOf = (values: Record<string, string>) => (name: string) => Effect.succeed(values[name] !== undefined ? Redacted.make(values[name]!) : undefined)

const setup = (opts: { scopes?: object; optional?: object; answers?: Array<"once" | "folder" | "always" | "deny">; yolo?: boolean; vault?: Record<string, string>; fetchImpl?: typeof fetch }) =>
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
  })
})
