import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "../src/build"
import { serve } from "../src/serve"
import { catalog, rendered, repo } from "./fixture"

test("the local server: pages by path, / is the overview, nothing outside the site", async () => {
  const root = repo()
  const out = join(mkdtempSync(join(tmpdir(), "zt-serve-")), "site")
  build({ catalog: catalog(root), rendered: rendered(), root, out })
  const server = serve(out, 0)
  try {
    const base = `http://localhost:${server.port}`
    const home = await fetch(`${base}/`)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("zarg catalog")
    expect((await fetch(`${base}/scenarios/S-1.html`)).status).toBe(200)
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
    expect((await fetch(`${base}/nope.html`)).status).toBe(404)
  } finally {
    server.stop(true)
  }
})
