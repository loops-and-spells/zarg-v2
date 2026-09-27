import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { makeClient } from "../src"

// A fake core: records requests and answers with fixed SSE, so the client is tested without @zarg/core.
const dir = mkdtempSync(join(tmpdir(), "zarg-client-"))
const socket = join(dir, "core.sock")
const seen: Array<{ method: string; path: string; auth: string | null; body: any }> = []
const sseBody = (chunks: ReadonlyArray<string>) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x))
      c.close()
    },
  })
const server = Bun.serve({
  unix: socket,
  async fetch(req) {
    const url = new URL(req.url)
    seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : undefined })
    if (req.headers.get("authorization") !== "Bearer tok") return Response.json({ error: "unauthorized" }, { status: 401 })
    if (url.pathname === "/threads") return Response.json([{ id: "main", focus: [], status: "idle" }])
    if (url.pathname === "/threads/main/stop") return Response.json({ stopped: "main" })
    if (url.pathname === "/reconcile") return Response.json({ on: true, pending: 1 })
    if (url.pathname === "/commands") return Response.json([{ plugin: "p", cmd: "/p-go", desc: "d", method: "command", arg: { kind: "none" } }])
    if (url.pathname === "/plugins/p/commands/p-go") return Response.json({ notice: "went" })
    if (url.pathname === "/rehearse") return Response.json({ run: "r-1", stories: 2, steps: 6, personas: ["dev"] })
    if (url.pathname === "/threads/main/rlms/rlm-2") return Response.json([{ type: "start", rlm: "rlm-2" }])
    if (url.pathname === "/threads/main/agents/rehearse%3At-1/body") return Response.json({ parts: [{ kind: "lines", lines: [{ text: "hi" }] }] })
    if (url.pathname === "/threads/main/agents/rehearse%3At-1/actions/apply") return Response.json({ notice: "applied" })
    // Events split across chunks and with CRLF-free multi-line framing, as a real stream may deliver them.
    return new Response(
      sseBody(['data: {"type":"RUN_STARTED","threadId":"main","seq":1}\n\n: comment\n\ndata: {"type":"RUN_FIN', 'ISHED","threadId":"main","seq":2}\n\n']),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const client = makeClient({ socket, token: "tok" })
const collect = <A, E>(s: Stream.Stream<A, E>) => Effect.runPromise(Stream.runCollect(s)).then((c) => [...c])

describe("client", () => {
  test("a run posts an AG-UI RunAgentInput and yields the parsed SSE events", async () => {
    const events = await collect(client.run({ threadId: "main", focus: ["S-0002"], message: "hello" }))
    expect(events.map((e) => [e.type, e.seq])).toEqual([["RUN_STARTED", 1], ["RUN_FINISHED", 2]])
    const body = seen.at(-1)!.body
    expect(body).toMatchObject({ threadId: "main", forwardedProps: { focus: ["S-0002"] }, messages: [{ role: "user", content: "hello" }] })
    expect(typeof body.runId).toBe("string")
    expect(body.resume).toBeUndefined()
  })

  test("an answer becomes a resume for the interrupt", async () => {
    await collect(client.run({ threadId: "main", answer: { interruptId: "inq-1", answer: { choice: "a" } } }))
    expect(seen.at(-1)!.body.resume).toEqual([{ interruptId: "inq-1", status: "resolved", payload: { choice: "a" } }])
    expect(seen.at(-1)!.body.messages).toEqual([])
  })

  test("stream, threads and stop send the token", async () => {
    await collect(client.stream(5))
    expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/stream?since=5", auth: "Bearer tok" })
    expect(await Effect.runPromise(client.threads())).toEqual([{ id: "main", focus: [], status: "idle" }])
    await Effect.runPromise(client.stop("main"))
    expect(await Effect.runPromise(client.reconcile())).toEqual({ on: true, pending: 1 })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/reconcile" })
    await Effect.runPromise(client.stop("main"))
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/threads/main/stop" })
  })

  test("rehearse posts the strategy and focus", async () => {
    expect(await Effect.runPromise(client.rehearse("teleport", ["UX-1"]))).toMatchObject({ run: "r-1" })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/rehearse", body: { strategy: "teleport", focus: ["UX-1"] } })
  })

  test("an agent's body and an action on its selected rows", async () => {
    expect(await Effect.runPromise(client.body("main", "rehearse:t-1"))).toEqual({ parts: [{ kind: "lines", lines: [{ text: "hi" }] }] })
    expect(await Effect.runPromise(client.act("main", "rehearse:t-1", "apply", ["R-1"]))).toEqual({ notice: "applied" })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/threads/main/agents/rehearse%3At-1/actions/apply", body: { rows: ["R-1"] } })
  })

  test("plugin commands are listed and run through the core", async () => {
    expect((await Effect.runPromise(client.commands())).map((c) => c.cmd)).toEqual(["/p-go"])
    expect(await Effect.runPromise(client.runCommand("p", "/p-go", ["x"]))).toEqual({ notice: "went" })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/plugins/p/commands/p-go", body: { args: ["x"] } })
  })

  test("a wrong token fails with CoreError 401; a missing socket fails as unreachable", async () => {
    const bad = await Effect.runPromise(Effect.flip(makeClient({ socket, token: "nope" }).threads()))
    expect(bad).toMatchObject({ _tag: "CoreError", status: 401 })
    const gone = await Effect.runPromise(Effect.flip(makeClient({ socket: join(dir, "missing.sock"), token: "tok" }).threads()))
    expect(gone).toMatchObject({ _tag: "CoreError", status: 0 })
    expect(gone.message).toContain("not reachable")
  })
})
