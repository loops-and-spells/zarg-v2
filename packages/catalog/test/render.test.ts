import { expect, test } from "bun:test"
import { renderAll } from "../src/render"
import { catalog } from "./fixture"

test("renderAll: every committed medium through its renderer, sanitized; a reason becomes a fallback; absent media is never rendered", async () => {
  const asked: Array<string> = []
  const r = await renderAll(catalog(), async (m) => {
    asked.push(m.path)
    return m.kind === "evidence-terminal/text"
      ? { ok: true as const, owner: "evidence-terminal", html: `<pre onclick="x()">${m.files[0]!.text}</pre><script>bad()</script>`, assets: [{ name: "t.css", path: "/x/t.css" }] }
      : { ok: false as const, reason: "rendered by evidence-terminal, not installed" }
  })
  expect(asked).toEqual(["media/S-1/after.txt", "media/S-1/step.cast"])
  expect(r.get("media/S-1/after.txt")).toEqual({ html: "<pre>plans <b></pre>", assets: [{ owner: "evidence-terminal", name: "t.css", path: "/x/t.css" }] })
  expect(r.get("media/S-1/step.cast")).toEqual({ fallback: "rendered by evidence-terminal, not installed" })
  expect(r.has("media/S-1/shot.png")).toBe(false)
})

test("renderers get URL-encoded file URLs", async () => {
  const c = catalog()
  const odd = { ...c, scenarios: c.scenarios.map((s) => (s.id === "S-1" ? { ...s, proof: { ...s.proof!, media: [{ ...s.proof!.media[0]!, files: [{ name: "a b.txt", url: "media/S-1/a b.txt" }] }] } } : s)) }
  const seen: Array<string> = []
  await renderAll(odd, async (m) => {
    seen.push(m.files[0]!.url)
    return { ok: false as const, reason: "x" }
  })
  expect(seen).toEqual(["media/S-1/a%20b.txt"])
})
