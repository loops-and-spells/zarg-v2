import { expect, test } from "bun:test"
import { sanitize } from "@zarg/catalog"
import { trace } from "@zarg/evidence-capture"
import { render } from "../src/render"

test("screenshots and gifs are images that open full size; video plays", async () => {
  const shot = render({ kind: "evidence-screen/screenshot", caption: "home", files: [{ name: "1-screenshot.png", url: "media/S-1/1-screenshot.png" }] })
  expect(shot.html).toBe('<a class="evidence-shot" href="../media/S-1/1-screenshot.png"><img src="../media/S-1/1-screenshot.png" alt="home" loading="lazy"></a>')
  const vid = render({ kind: "evidence-screen/video", caption: "run", files: [{ name: "1-video.webm", url: "media/S-1/1-video.webm" }] })
  expect(vid.html).toBe('<video class="evidence-video" controls preload="metadata" src="../media/S-1/1-video.webm"></video>')
  for (const r of [shot, vid]) expect(await sanitize(r.html)).toBe(r.html)
})

test("a trace is a timeline: each action with its screenshot, console and requests; failures marked; an action without a screenshot has none", async () => {
  const t = trace("saving a plan")
  t.action("open /plans", { screenshot: new Uint8Array([1]), ms: 80 })
  t.action("click Save", { console: [{ level: "error", text: "boom <x>" }], requests: [{ method: "POST", url: "/api/save", status: 500, ms: 41 }] })
  const c = t.done()
  const r = render({
    kind: "evidence-screen/trace",
    caption: "saving a plan",
    meta: { files: ["media/S-1/2-001.png"] },
    files: [{ name: "2-trace.json", url: "media/S-1/2-trace.json", text: c.files["trace.json"] as string }, { name: "2-001.png", url: "media/S-1/2-001.png" }],
  })
  expect(r.assets).toEqual(["screen.css", "trace.js"])
  expect(r.html.match(/class="evidence-step(?: failed)?"/g)).toEqual(['class="evidence-step"', 'class="evidence-step failed"'])
  expect(r.html).toContain('<img src="../media/S-1/2-001.png" alt="open /plans" loading="lazy">')
  expect(r.html).toContain("POST /api/save")
  expect(r.html).toContain('<span class="status bad">500</span>')
  expect(r.html).toContain("boom &lt;x&gt;")
  expect(r.html.split("evidence-step failed")[1]).not.toContain("<img")
  expect(await sanitize(r.html)).toBe(r.html)
})
