import { expect, test } from "bun:test"
import { ALIASES, FIRST_PARTY_KINDS, isKindRef, isText, resolveKind, screenshot, text, trace, video } from "../src"

test("old kinds read through their aliases; refs stay", () => {
  expect(["buffer", "log", "cast", "image", "gif", "video"].map(resolveKind)).toEqual(["evidence-terminal/text", "evidence-terminal/text", "evidence-terminal/cast", "evidence-screen/screenshot", "evidence-screen/gif", "evidence-screen/video"])
  expect(resolveKind("evidence-x/thing")).toBe("evidence-x/thing")
  expect(Object.values(ALIASES).every(isKindRef)).toBe(true)
  expect(isKindRef("Bad/Kind")).toBe(false)
})

test("text or binary: declared kinds, the first-party table, aliases; undeclared is binary", () => {
  const t = isText({ "evidence-x/notes": { label: "notes", files: "text" } })
  expect([t("evidence-x/notes"), t("buffer"), t("cast"), t("evidence-terminal/frame"), t("image"), t("evidence-screen/trace"), t("evidence-y/unknown")]).toEqual([true, true, true, true, false, false, false])
  expect(FIRST_PARTY_KINDS["evidence-terminal/frame"]).toEqual({ label: "terminal frame", files: "text" })
})

test("builders: a capture is a kind, a caption and its files", () => {
  expect(text("zarg agenda", "$ zarg agenda\n[]", { fold: true })).toEqual({ kind: "evidence-terminal/text", caption: "zarg agenda", files: { "text.txt": "$ zarg agenda\n[]" }, meta: { fold: true } })
  const png = new Uint8Array([137, 80, 78, 71])
  expect(screenshot("home", png)).toEqual({ kind: "evidence-screen/screenshot", caption: "home", files: { "screenshot.png": png } })
  expect(video("run", png, "video/webm")).toMatchObject({ kind: "evidence-screen/video", files: { "video.webm": png }, meta: { mime: "video/webm" } })
})

test("a trace: one entry per action, its screenshots numbered", () => {
  const t = trace("saving a plan")
  t.action("open /plans", { screenshot: new Uint8Array([1]), ms: 80 })
  t.action("click Save", { screenshot: new Uint8Array([2]), console: [{ level: "error", text: "boom" }], requests: [{ method: "POST", url: "/api/save", status: 500, ms: 41 }] })
  const c = t.done()
  expect(c.kind).toBe("evidence-screen/trace")
  expect(Object.keys(c.files)).toEqual(["trace.json", "001.png", "002.png"])
  expect(JSON.parse(c.files["trace.json"] as string)).toEqual([
    { action: "open /plans", screenshot: "001.png", console: [], requests: [], ms: 80 },
    { action: "click Save", screenshot: "002.png", console: [{ level: "error", text: "boom" }], requests: [{ method: "POST", url: "/api/save", status: 500, ms: 41 }] },
  ])
})
