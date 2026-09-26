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
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/threads/main/stop" })
  })

  test("a wrong token fails with CoreError 401; a missing socket fails as unreachable", async () => {
    const bad = await Effect.runPromise(Effect.flip(makeClient({ socket, token: "nope" }).threads()))
    expect(bad).toMatchObject({ _tag: "CoreError", status: 401 })
    const gone = await Effect.runPromise(Effect.flip(makeClient({ socket: join(dir, "missing.sock"), token: "tok" }).threads()))
    expect(gone).toMatchObject({ _tag: "CoreError", status: 0 })
    expect(gone.message).toContain("not reachable")
  })
})
