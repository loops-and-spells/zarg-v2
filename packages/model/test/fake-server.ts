/** A throwaway HTTP server for provider tests. Each handler gets the request and its body. */
export const fakeServer = (handler: (req: Request, body: string) => Response | Promise<Response>) => {
  const requests: Array<{ path: string; body: string; auth: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      requests.push({ path: new URL(req.url).pathname, body, auth: req.headers.get("authorization") })
      return handler(req, body)
    },
  })
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) }
}

/** An SSE response from `data:` frames and raw text (comments), with optional pauses in ms. */
export const sse = (parts: ReadonlyArray<object | string | number>) =>
  new Response(
    new ReadableStream({
      async start(c) {
        const enc = new TextEncoder()
        for (const p of parts) {
          if (typeof p === "number") await Bun.sleep(p)
          else if (typeof p === "string") c.enqueue(enc.encode(p))
          else c.enqueue(enc.encode(`data: ${JSON.stringify(p)}\n\n`))
        }
        c.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

export const delta = (d: object, finish?: string) => ({ choices: [{ delta: d, finish_reason: finish ?? null }] })
