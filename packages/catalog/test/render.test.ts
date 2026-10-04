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
