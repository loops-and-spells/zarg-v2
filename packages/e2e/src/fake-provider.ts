/** An OpenRouter-wire provider for setup steps: GET /models lists `models`; GET /key accepts only `key` (as OpenRouter checks a key). */
export const fakeProvider = (opts: { readonly key: string; readonly models: ReadonlyArray<string> }) => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (path === "/api/v1/models") return Response.json({ data: opts.models.map((id) => ({ id, name: id, context_length: 32_768 })) })
      if (path === "/api/v1/key") return req.headers.get("authorization") === `Bearer ${opts.key}` ? Response.json({ data: { label: "e2e" } }) : new Response("refused", { status: 401 })
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/api/v1`, stop: () => void server.stop(true) }
}
