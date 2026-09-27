import type { Layout, LogLine } from "@zarg/view"

/** An RLM's view: its status, its task and current cell, its history. */
export const RLM_LAYOUT: Layout = {
  name: "rlm",
  sections: [
    { id: "status", kind: "stats", role: "summary" },
    { id: "task", kind: "text", role: "primary", title: "Task" },
    { id: "history", kind: "log", role: "log", title: "History" },
  ],
}

const HISTORY_CODE_LINES = 8
const HISTORY_OUTPUT_LINES = 6
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const firstLines = (text: string, n: number) => {
  const all = text.split("\n")
  return all.length > n ? [...all.slice(0, n), `… ${all.length - n} more lines`] : all
}
const line = (text: string, tone?: "dim" | "error" | "accent"): LogLine => (tone === undefined ? { text } : { text, tone })

/** One transcript record as history lines. */
export const rlmLines = (l: Record<string, any>): ReadonlyArray<LogLine> => {
  switch (l.type) {
    case "start":
      return [line(`${l.preset} ${l.rlm}: ${String(l.task ?? "").split("\n")[0]}`)]
    case "model":
      return [line(`turn ${l.turn} · model ${(Number(l.modelMs) / 1000).toFixed(1)}s · ${Number(l.promptTokens).toLocaleString("en-US")} → ${Number(l.completionTokens).toLocaleString("en-US")} tokens`, "accent")]
    case "call": {
      const head = `  ${l.service}.${l.method} ${clip(JSON.stringify(l.params), 120)}  ${l.ms}ms`
      return [l.ok ? line(head, "dim") : line(`${head}  failed: ${l.failure?._tag}: ${clip(String(l.failure?.message ?? ""), 120)}`, "error")]
    }
    case "step":
      return [
        ...(String(l.text ?? "").trim().length > 0 ? [line(`  ${clip(String(l.text).trim().replaceAll("\n", " "), 300)}`)] : []),
        ...(l.cells ?? []).flatMap((c: { code: string; ok: boolean; output: string; ms: number }) => [
          line(`  cell ${c.ok ? "ok" : "failed"} ${c.ms}ms`, c.ok ? "dim" : "error"),
          ...firstLines(c.code, HISTORY_CODE_LINES).map((t) => line(`    │ ${t}`, "dim")),
          ...firstLines(c.output, HISTORY_OUTPUT_LINES).filter((t) => t.length > 0).map((t) => line(`    → ${t}`, c.ok ? undefined : "error")),
        ]),
      ]
    case "atomize":
      return [line(l.atomic ? "atomic (runs directly)" : "plan (splits into children)", "accent")]
    case "plan":
      return [line(`plan: ${(l.children ?? []).map((c: { id: string; preset: string }) => `${c.id} (${c.preset})`).join(", ")}`, "accent")]
    case "extend":
      return [line(`${(l.extended ? `extended to ${l.turns} turns` : "told to wrap up").padEnd(15)}  ${Number(l.confidence).toFixed(2)}  ${l.reason}`, "accent")]
    default:
      return []
  }
}
