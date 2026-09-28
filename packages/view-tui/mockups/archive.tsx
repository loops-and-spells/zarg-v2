// THROWAWAY MOCKUP (never commit): agents that stopped leave the tree: at start, after a TTL, or archived by hand.
import { testRender } from "@opentui/react/test-utils"

const C = { zarg: "#e8eaed", dim: "#6b7075", accent: "#81c995", attn: "#f6ae2d", select: "#3c4043", err: "#f28b82" }
type Row = { t: string; c: keyof typeof C; sel?: boolean }

const Tree = (p: { rows: ReadonlyArray<Row>; title: string; foot: string }) => (
  <box title={p.title} style={{ width: 58, flexDirection: "column", border: true, borderColor: C.accent }}>
    {p.rows.map((r) => (
      <text key={r.t} fg={C[r.c]} wrapMode="none" {...(r.sel ? { bg: C.select } : {})}>{r.t}</text>
    ))}
    <box style={{ flexGrow: 1 }} />
    <text fg={C.dim} wrapMode="none">{p.foot}</text>
  </box>
)

const before: ReadonlyArray<Row> = [
  { t: "◆ zarg              asks: What next?", c: "attn" },
  { t: "  └ ● rlm-4         turn 2/25", c: "zarg" },
  { t: "◆ rehearse r-3f2a   4 findings to review", c: "attn" },
  { t: "  └ ◆ tester-1      4 findings to review", c: "attn" },
  { t: "✓ rehearse r-9b92   done · 2h ago  · ttl 22h", c: "dim", sel: true },
  { t: "  ├ ✓ tester-1      done · 2h ago", c: "dim" },
  { t: "  └ ✓ tester-2      done · 2h ago", c: "dim" },
  { t: "■ rlm-1             stopped · zarg restarted · 5m ago", c: "dim" },
  { t: "✗ rlm-2             failed · budget · 1d ago  · ttl 0h", c: "err" },
]
const after: ReadonlyArray<Row> = [
  { t: "◆ zarg              asks: What next?", c: "attn" },
  { t: "  └ ● rlm-4         turn 2/25", c: "zarg" },
  { t: "◆ rehearse r-3f2a   4 findings to review", c: "attn" },
  { t: "  └ ◆ tester-1      4 findings to review", c: "attn" },
  { t: "▸ Archived (4)      x restore · Enter open", c: "dim", sel: true },
]
const shown: ReadonlyArray<Row> = [
  ...after.slice(0, 4),
  { t: "▾ Archived (4)", c: "dim" },
  { t: "  ✓ rehearse r-9b92  archived by you · 1m ago", c: "dim", sel: true },
  { t: "  ■ rlm-1            stopped at start · 5m ago", c: "dim" },
  { t: "  ✗ rlm-2            ttl (24h) · 1d ago", c: "err" },
  { t: "  ✓ tester-1..2      with r-9b92", c: "dim" },
]

const frames = [
  ["1. before: finished agents wait, their age and time left shown (x archives the highlighted one)", <Tree rows={before} title="Agents ◆2" foot="↑↓ move · Enter open · x archive · X archive all finished" />],
  ["2. after x on r-9b92, start-up clean-up and the 24h ttl: one collapsed Archived row", <Tree rows={after} title="Agents ◆2" foot="↑↓ move · Enter open · x archive" />],
  ["3. Archived opened: why each left; x restores", <Tree rows={shown} title="Agents ◆2" foot="↑↓ move · Enter open · x restore · D delete for good" />],
] as const
for (const [name, el] of frames) {
  const t = await testRender(el, { width: 60, height: 14, exitOnCtrlC: false, exitSignals: [] })
  await t.renderOnce()
  console.log(`\n=== ${name} ===\n${t.captureCharFrame()}`)
  t.renderer.destroy()
}
