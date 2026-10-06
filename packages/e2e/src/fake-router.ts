/**
 * A zarg-router stand-in on the OpenRouter wire: models with a state, `/admin/warm` (slow, or failing), and chat turns
 * that each answer with the next scripted cell as an `exec` tool call (the last one repeats). Nothing real is loaded.
 */
export const fakeRouter = (opts: { readonly model: string; readonly warmMs?: number; readonly failWarm?: string; readonly cells: ReadonlyArray<string> }) => {
  let state = "cold"
  let turn = 0
  // Turns asked for before the model was warm (none, when zarg waits for the warm-up).
  let cold = 0
  const sse = (frames: ReadonlyArray<unknown>) =>
    new Response(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/api/v1/models")
        return Response.json({ data: [{ id: opts.model, name: opts.model, context_length: 32_768, supported_parameters: ["max_tokens", "tools", "tool_choice"], state }] })
      if (path === "/admin/warm") {
        state = "loading"
        await Bun.sleep(opts.warmMs ?? 0)
        if (opts.failWarm !== undefined) {
          state = "cold"
          return new Response(opts.failWarm, { status: 500 })
        }
        state = "running"
        return Response.json({ ok: true })
      }
      if (path === "/api/v1/chat/completions") {
        if (state !== "running") cold++
        const code = opts.cells[Math.min(turn++, opts.cells.length - 1)] ?? 'yield* Rlm.done({ value: "(no script)" })'
        return sse([
          { id: `t${turn}`, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${turn}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } }] }, finish_reason: null }] },
          { id: `t${turn}`, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          "[DONE]",
        ])
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/api/v1`, state: () => state, coldTurns: () => cold, stop: () => void server.stop(true) }
}
