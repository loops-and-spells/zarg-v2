// Live smoke test (outside `mise run verify`): one real driver item through core, the client session and
// the configured driver model. The run happens in a scratch copy of this project's graph and config, so the
// driver's writes never touch the repo. The first inquiry gets its recommended option (or the first); the run
// passes when the driver makes progress after the answer (another turn, a summary or its next question).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import type { SessionState } from "@zarg/client"
import { openSession } from "../src/tui/run"

const repo = resolve(process.env.ZARG_ROOT ?? process.cwd())
const TIMEOUT_MS = 5 * 60_000

// A scratch project: the repo's graph and config, and its .env.schema with imports made absolute.
const root = mkdtempSync(join(tmpdir(), "zarg-smoke-chat-"))
cpSync(join(repo, ".zarg", "graph"), join(root, ".zarg", "graph"), { recursive: true })
cpSync(join(repo, ".zarg", "config.toml"), join(root, ".zarg", "config.toml"))
writeFileSync(join(root, ".env.schema"), readFileSync(join(repo, ".env.schema"), "utf8").replaceAll("@import(./", `@import(${repo}/`))

const threadId = "smoke"
const opened = await Effect.runPromise(openSession({ root, threadId, focus: [] }))
console.log(`scratch ${root}\ncore ${opened.meta.mode}, driver ${opened.meta.driver ?? "?"}`)

let printed = 0
/** Print messages up to `n`; a message is complete once a newer one started (or the run is over). */
const print = (s: SessionState, n: number) => {
  for (const m of s.thread.messages.slice(printed, n)) console.log(`${m.role === "user" ? "you " : "zarg"}  ${m.text}`)
  printed = Math.max(printed, n)
}
const turns = (s: SessionState) => Object.values(s.thread.rlms).reduce((sum, r) => sum + r.turns, 0)

const verdict = await new Promise<{ ok: boolean; why: string }>((done) => {
  let answered: { id: string; turns: number; messages: number } | undefined
  const check = (s: SessionState) => {
    print(s, s.thread.messages.length - 1)
    if (s.core === "down") return done({ ok: false, why: s.notice ?? "core stopped" })
    if (s.thread.status === "error") return done({ ok: false, why: `${s.thread.error?.code}: ${s.thread.error?.message}` })
    const q = s.thread.pendingInquiry
    if (q !== undefined && answered === undefined) {
      const pick = q.options.find((o) => o.recommended) ?? q.options[0]
      console.log(`?     ${q.question}\n      → ${pick?.label ?? "(free text)"}`)
      answered = { id: q.id, turns: turns(s), messages: s.thread.messages.length }
      opened.session.answer(pick !== undefined ? { choice: pick.id } : { other: "Pick the most valuable next step and go." })
    } else if (answered !== undefined) {
      const newQuestion = q !== undefined && q.id !== answered.id
      const summary = s.thread.messages.slice(answered.messages).some((m) => m.role === "assistant" && m.text.length > 0)
      if (newQuestion || summary || turns(s) > answered.turns) done({ ok: true, why: "the driver continued after the answer" })
    }
  }
  opened.session.subscribe(() => check(opened.session.state()))
  setTimeout(() => done({ ok: false, why: `no progress within ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS)
  opened.session.start()
})

const s = opened.session.state()
print(s, s.thread.messages.length)
for (const r of Object.values(s.thread.rlms)) console.log(`rlm   ${r.preset} ${r.id} ${r.turns}/${r.budget} ${r.status}`)
await opened.close()
console.log(`transcript ${join(root, ".zarg", "threads", `${threadId}.rlm.jsonl`)}`)
console.log(verdict.ok ? `PASS: ${verdict.why}` : `FAIL: ${verdict.why}`)
process.exit(verdict.ok ? 0 : 1)
