import { existsSync, statSync } from "node:fs"
import { join, normalize, resolve, sep } from "node:path"

/** The built catalog over HTTP, for reading it locally: files under `dir` only, `/` as the overview. */
export const serve = (dir: string, port: number) => {
  const base = resolve(dir)
  return Bun.serve({
    port,
    fetch: (req) => {
      let path: string
      try {
        path = decodeURIComponent(new URL(req.url).pathname)
      } catch {
        return new Response("bad path", { status: 400 })
      }
      const file = join(base, normalize(path.endsWith("/") ? `${path}index.html` : path))
      if (!(file === base || file.startsWith(base + sep)) || !existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 })
      return new Response(Bun.file(file))
    },
  })
}

if (import.meta.main) {
  const server = serve(process.argv[2] ?? "site", Number(process.env.PORT ?? 4173))
  console.log(`the catalog: http://localhost:${server.port}`)
}
