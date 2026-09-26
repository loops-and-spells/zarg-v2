// A stand-in for zarg-core with the same command line and core.json contract. FAKE_CORE=fail exits with an error.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string" } } })
const root = values.root!
if (process.env.FAKE_CORE === "fail") {
  console.error("config error: roles.driver is not set")
  process.exit(1)
}
const run = join(root, ".zarg", "run")
mkdirSync(run, { recursive: true })
const socket = join(run, "core.sock")
const server = Bun.serve({ unix: socket, fetch: () => Response.json([]) })
writeFileSync(join(run, "core.json"), JSON.stringify({ pid: process.pid, socket, token: "t", mode: values.mode }), { mode: 0o600 })
const bye = () => {
  server.stop(true)
  rmSync(join(run, "core.json"), { force: true })
  process.exit(0)
}
process.on("SIGTERM", bye)
if (values.mode === "child") {
  process.stdin.on("end", bye)
  process.stdin.resume()
}
console.log(`ready ${socket}`)
