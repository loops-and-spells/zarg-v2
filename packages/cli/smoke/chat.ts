// Live smoke test (outside `mise run verify`): one real driver item through core, the client session and
// the configured driver model. The first inquiry gets its recommended option (or the first); the run passes
// when the driver then writes a summary or asks its next question.
import { Effect } from "effect"
import type { SessionState } from "@zarg/client"
import { openSession } from "../src/tui/run"

const root = process.env.ZARG_ROOT ?? process.cwd()
const TIMEOUT_MS = 5 * 60_000
const opened = await Effect.runPromise(openSession({ root, threadId: `smoke-${Date.now()}`, focus: [] }))
console.log(`core ${opened.meta.mode}, driver ${opened.meta.driver ?? "?"}`)

const verdict = await new Promise<{ ok: boolean; why: string }>((done) => {
  let answered: string | undefined
  let seen = 0
  const check = (s: SessionState) => {
    for (const m of s.thread.messages.slice(seen)) console.log(`${m.role === "user" ? "you " : "zarg"}  ${m.text}`)
    seen = s.thread.messages.length
    if (s.core === "down") return done({ ok: false, why: s.notice ?? "core stopped" })
    if (s.thread.status === "error") return done({ ok: false, why: `${s.thread.error?.code}: ${s.thread.error?.message}` })
    const q = s.thread.pendingInquiry
    if (q !== undefined && answered === undefined) {
      const pick = q.options.find((o) => o.recommended) ?? q.options[0]!
      console.log(`?     ${q.question}\n      → ${pick.label}`)
      answered = q.id
      opened.session.answer({ choice: pick.id })
    } else if (answered !== undefined && (s.thread.messages.at(-1)?.role === "assistant" || (q !== undefined && q.id !== answered))) {
      done({ ok: true, why: "the driver continued after the answer" })
    }
  }
  opened.session.subscribe(() => check(opened.session.state()))
  setTimeout(() => done({ ok: false, why: `no progress within ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS).unref()
  opened.session.start()
})

const s = opened.session.state()
for (const r of Object.values(s.thread.rlms)) console.log(`rlm   ${r.preset} ${r.id} ${r.turns}/${r.budget} ${r.status}`)
await opened.close()
console.log(verdict.ok ? `PASS: ${verdict.why}` : `FAIL: ${verdict.why}`)
process.exit(verdict.ok ? 0 : 1)
