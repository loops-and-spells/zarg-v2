// THROWAWAY MOCKUP (not product code): a tester agent owning the main window.
// Live:    mise x -- bun packages/cli/mockups/tester.tsx      (q or Esc quits)
// Frame:   mise x -- bun packages/cli/mockups/tester.tsx --frame
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"

const C = { zarg: "#e8eaed", dim: "#9aa0a6", accent: "#81c995", notice: "#fdd663", error: "#f28b82", select: "#3c4043", you: "#8ab4f8" }

const story = ["UX-0001", "UX-0004", "UX-0012", "UX-0015", "UX-0020"]
const at = 2
const steps: ReadonlyArray<{ mark: string; tone: keyof typeof C; text: string }> = [
  { mark: "✓", tone: "dim", text: "UX-0001  Visitor opens the shop        feel 1.80  fail 0.10  arrive 0.95" },
  { mark: "⚑", tone: "notice", text: "UX-0004  Visitor opens the cart        feel 1.05  fail 0.22  arrive 0.88  → friction" },
  { mark: "✓", tone: "dim", text: "UX-0004▸UX-0012  cart → pay            feel 1.62  fail 0.18  arrive 0.91" },
  { mark: "●", tone: "accent", text: "UX-0012  Visitor pays                 screening…" },
]
const workers: ReadonlyArray<{ mark: string; tone: keyof typeof C; story: string; path: string; what: string }> = [
  { mark: "●", tone: "accent", story: "story 3", path: "UX-0001 ▸ UX-0004 ▸ [UX-0012] ▸ UX-0015", what: "screening: feel · fail · arrive" },
  { mark: "●", tone: "accent", story: "story 4", path: "UX-0001 ▸ UX-0007 ▸ [UX-0009]", what: "screening: feel · fail · arrive" },
  { mark: "●", tone: "notice", story: "story 1", path: "UX-0001 ▸ [UX-0004]", what: "diagnosing friction (large model)" },
  { mark: "●", tone: "accent", story: "story 6", path: "UX-0002 ▸ [UX-0003]", what: "screening: feel · fail · arrive" },
  { mark: "●", tone: "accent", story: "story 8", path: "UX-0002 ▸ UX-0011 ▸ [UX-0014]", what: "screening: feel · fail · arrive" },
  { mark: "◌", tone: "dim", story: "story 5", path: "UX-0001 ▸ UX-0004 ▸ [UX-0012]", what: "waits for story 3 at UX-0012" },
  { mark: "◌", tone: "dim", story: "story 2", path: "UX-0001 ▸ [UX-0004]", what: "waits for story 1 at UX-0004" },
  { mark: "◌", tone: "dim", story: "story 7", path: "UX-0002 ▸ [UX-0003]", what: "waits for story 6 at UX-0003" },
]
const findings = [
  { sel: true, id: "R-a1b2c3d4", kind: "friction", card: "UX-0004", sev: "medium", route: "fix 0.82", note: "The cart hides the total until checkout" },
  { sel: false, id: "R-9f8e7d6c", kind: "gap", card: "UX-0012", sev: "high", route: "fix 0.77", note: "No card for a declined payment" },
  { sel: false, id: "R-5544aa01", kind: "seam", card: "UX-0015", sev: "low", route: "split 0.61", note: "Receipt and email arrive as one step" },
]
const agents = [
  { text: "▾ ● driver            turn 3/25", tone: "zarg" as const },
  { text: "▾ ● rehearse run r-3f2a", tone: "zarg" as const },
  { text: "   ● tester-1 The developer  14/22", tone: "accent" as const, sel: true },
]

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const bar = (done: number, total: number, w = 24) => "█".repeat(Math.round((done / total) * w)).padEnd(w, "░")

function Tester() {
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {/* The agent's own window: header, work area, pinned findings. */}
        <box title="tester-1 · The developer · run r-3f2a · edge-pair · Esc back" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.accent }}>
          <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1 }}>
            <text fg={C.zarg}>{`${bar(14, 22)}  14/22 steps   3 flagged   1 unreachable   2m 41s`}</text>
          </box>
          <box title="Workers  5 busy of 8 · 3 waiting on a shared step" style={{ flexDirection: "column", flexShrink: 0, border: true, borderColor: C.dim, paddingLeft: 1 }}>
            {workers.map((w, i) => (
              <text key={i} fg={C[w.tone]} wrapMode="none">{`${w.mark} ${pad(w.story, 9)} ${pad(w.path, 44)} ${w.what}`}</text>
            ))}
          </box>
          <box title="Steps" style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.dim, paddingLeft: 1, overflow: "hidden" }}>
            {steps.map((s, i) => (
              <text key={i} fg={C[s.tone]} wrapMode="none">{`${s.mark} ${s.text}`}</text>
            ))}
          </box>
          <box title="Findings (3)   Likes (5)" style={{ flexDirection: "column", flexShrink: 0, border: true, borderColor: C.notice, paddingLeft: 1 }}>
            <text fg={C.dim}>{`     ${pad("id", 11)} ${pad("kind", 9)} ${pad("card", 8)} ${pad("sev", 7)} ${pad("route", 10)} note`}</text>
            {findings.map((f, i) => (
              <text key={f.id} wrapMode="none" fg={i === 0 ? C.accent : C.zarg} {...(i === 0 ? { bg: C.select } : {})}>
                {`${i === 0 ? "▸" : " "} [${f.sel ? "x" : " "}] ${pad(f.id, 11)} ${pad(f.kind, 9)} ${pad(f.card, 8)} ${pad(f.sev, 7)} ${pad(f.route, 10)} ${f.note}`}
              </text>
            ))}
            <text fg={C.dim}>{"↑↓ move · space select · a apply · d dismiss · Tab likes · Enter details"}</text>
          </box>
        </box>
        <box title="Agents" style={{ width: 40, flexDirection: "column", border: true, borderColor: C.dim }}>
          {agents.map((a) => (
            <text key={a.text} fg={C[a.tone]} wrapMode="none" {...(a.sel ? { bg: C.select } : {})}>
              {a.text}
            </text>
          ))}
        </box>
      </box>
      <box style={{ height: 1, flexShrink: 0 }}>
        <text fg={C.dim}>{"zarg-router:deepseek · main · core up   Esc back to the conversation"}</text>
      </box>
    </box>
  )
}

if (process.argv.includes("--frame")) {
  const t = await testRender(<Tester />, { width: 130, height: 34, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  console.log(t.captureCharFrame())
  t.renderer.destroy()
} else {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  renderer.keyInput.on("keypress", (k: { name: string }) => {
    if (k.name === "q" || k.name === "escape") {
      renderer.destroy()
      process.exit(0)
    }
  })
  createRoot(renderer).render(<Tester />)
}
