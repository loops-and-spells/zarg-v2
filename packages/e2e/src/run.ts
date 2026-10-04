import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { readEvidence } from "@zarg/audit/evidence"
import { preflight } from "./preflight"
import { REPO } from "./world"

export const ROUTER_URL = "http://localhost:11435/api/v1"
/** What the full tier's model steps run on: the driver and the decision model. */
export const MODELS = ["deepseek-v4.1-flash-exl3", "jevk5"]
const JOURNEYS = join(import.meta.dir, "..", "journeys")

/** Every journey (or one), one after another, each in its own fresh world; the answer is the exit code. */
// @scenario S-0114
export const run = async (opts: { readonly tier: "fast" | "full"; readonly only?: string; readonly url: string }): Promise<number> => {
  const files = opts.only !== undefined ? [`${opts.only}.test.ts`] : readdirSync(JOURNEYS).filter((f) => /^J-\d+\.test\.ts$/.test(f)).sort()
  for (const f of files) if (!existsSync(join(JOURNEYS, f))) throw new Error(`no journey ${f.replace(".test.ts", "")} (journeys/${f})`)
  // The fast tier has no model turns: it never needs the router.
  if (opts.tier === "full") await preflight(opts.url, MODELS)
  // One run id for the whole suite, though each journey is its own process.
  const runId = `e2e-${new Date().toISOString().replace(/:/g, "-")}`
  const results = files.map((f) => {
    const id = f.replace(".test.ts", "")
    const p = Bun.spawnSync([process.execPath, "test", join(JOURNEYS, f)], { cwd: REPO, env: { ...process.env, E2E_TIER: opts.tier, E2E_ZARG_ROUTER_URL: opts.url, E2E_RUN: runId }, stdout: "inherit", stderr: "inherit" })
    const flaky = readEvidence(process.env.E2E_EVIDENCE_OUT ?? REPO).filter((e) => e.evidence?.journey === id && e.evidence.run === runId && e.evidence.flaky).length
    return { id, passed: p.exitCode === 0, flaky }
  })
  for (const r of results) console.log(`${r.passed ? "✓" : "✗"} ${r.id}${r.flaky > 0 ? ` (${r.flaky} flaky)` : ""}`)
  const failed = results.filter((r) => !r.passed).length
  console.log(`${results.length - failed} passed, ${failed} failed (${opts.tier} tier)`)
  return failed === 0 ? 0 : 1
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const only = args.find((a) => /^J-\d+$/.test(a))
  try {
    process.exit(await run({ tier: args.includes("--full") ? "full" : "fast", ...(only === undefined ? {} : { only }), url: process.env.E2E_ZARG_ROUTER_URL ?? ROUTER_URL }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
}
