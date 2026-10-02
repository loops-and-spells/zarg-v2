// Live smoke test (outside `mise run verify`): one real card through plan and implement. It runs in a scratch
// clone of this repo (your checkout is never touched): a core starts there, a small card is added to the graph,
// and the run passes when a pass lands "feat: implement <card>" (or fails with the findings it raised).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { connect } from "@zarg/client"
import { coreCommand } from "../src/tui/run"

const repo = resolve(process.env.ZARG_ROOT ?? process.cwd())
const TIMEOUT_MS = 20 * 60_000
const cli = join(repo, "packages/cli/src/main.ts")
const run = (cwd: string, argv: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const p = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...env } })
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

const scratch = mkdtempSync(join(tmpdir(), "zarg-smoke-implement-"))
run(tmpdir(), ["git", "clone", "-q", "--no-hardlinks", repo, scratch])
run(scratch, ["mise", "trust", "-q"])
// Only the new card may be taken up: turn reconcile on in the clone and mark its existing graph reconciled.
const configFile = join(scratch, ".zarg/config.toml")
writeFileSync(configFile, readFileSync(configFile, "utf8").replace(/^enabled = false$/m, "enabled = true"))
run(scratch, [process.execPath, cli, "checkpoint"], { ZARG_ROOT: scratch })
run(scratch, ["git", "-c", "user.name=zarg smoke", "-c", "user.email=smoke@zarg", "commit", "-qam", "smoke: checkpoint"])
console.log(`scratch ${scratch}`)

const conn = await Effect.runPromise(connect({ root: scratch, command: coreCommand() }))
console.log(`core ${conn.info.mode} (pid ${conn.info.pid}), driver model ${conn.info.driver ?? "?"}`)
run(scratch, [process.execPath, cli, "tool", "call", "gherkin/add-persona", JSON.stringify({ name: "CLI actor", kind: "cli", text: "A coding agent at the command line." })], { ZARG_ROOT: scratch })
const added = JSON.parse(
  run(scratch, [process.execPath, cli, "tool", "call", "gherkin/add-card", JSON.stringify({ title: "CLI actor reads the zarg version", when: "the CLI actor runs zarg version", by: [{ name: "CLI actor" }], arrives: { id: "S-0001" }, then: [{ text: "the zarg version is printed" }] })], { ZARG_ROOT: scratch }),
) as { added: ReadonlyArray<string> }
const card = added.added.find((id) => id.startsWith("C-"))!
console.log(`added ${card}; waiting for plan and implement (up to ${TIMEOUT_MS / 60_000} min)`)

const findingsFile = join(scratch, ".zarg/reconcile/findings.json")
const findings = () => (existsSync(findingsFile) ? (JSON.parse(readFileSync(findingsFile, "utf8")) as ReadonlyArray<{ kind: string; title: string; detail: string }>) : [])
const deadline = Date.now() + TIMEOUT_MS
let verdict: { ok: boolean; why: string } | undefined
while (verdict === undefined) {
  const subject = run(scratch, ["git", "log", "-1", "--format=%s"])
  if (subject === `feat: implement ${card}`) verdict = { ok: true, why: `landed: ${subject} (${run(scratch, ["git", "rev-parse", "--short", "HEAD"])})` }
  else if (findings().length > 0) verdict = { ok: false, why: findings().map((f) => `${f.kind}: ${f.title} — ${f.detail.slice(0, 300)}`).join("\n") }
  else if (Date.now() > deadline) verdict = { ok: false, why: "no pass landed in time" }
  else await Bun.sleep(5000)
}
await conn.close()
if (verdict.ok) console.log(run(scratch, ["git", "show", "--stat", "--format=%s", "HEAD"]))
console.log(`transcripts ${join(scratch, ".zarg/threads")}/{plan,implement}.rlm.jsonl`)
console.log(verdict.ok ? `PASS: ${verdict.why}` : `FAIL: ${verdict.why}`)
process.exit(verdict.ok ? 0 : 1)
