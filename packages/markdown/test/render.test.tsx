import { afterEach, expect, test } from "bun:test"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { Markdown } from "../src/react"

const style = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" }, "markup.heading": { fg: "#00ffff", bold: true } })
let destroy: (() => void) | undefined
afterEach(async () => { await act(async () => destroy?.()) })
const diagram = "```mermaid\nflowchart LR\n  A[Read] --> B[Render]\n```"

// @card C-0075
// @card C-0077
// @card C-0078
test("embedded Markdown streams Mermaid, falls back for narrow views, and recovers on resize", async () => {
  let update!: (value: { content: string; width: number }) => void
  const View = () => {
    const [value, setValue] = useState({ content: "# Report\n\n" + diagram.slice(0, -3), width: 80 })
    update = setValue
    return <Markdown {...value} syntaxStyle={style} streaming />
  }
  const t = await testRender(<View />, { width: 80, height: 24, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  const frame = async () => { await t.renderOnce(); await Bun.sleep(20); await t.renderOnce(); return t.captureCharFrame() }
  expect(await frame()).toContain("A[Read] --> B[Render]")
  await act(async () => update({ content: "# Report\n\n" + diagram + "\n\nFinished.", width: 80 }))
  const rendered = await frame()
  expect(rendered).toContain("Read")
  expect(rendered).toContain("Render")
  expect(rendered).toMatch(/[┌╭]/)
  expect(rendered).not.toContain("A[Read]")
  expect(rendered).toContain("Finished.")
  await act(async () => update({ content: diagram, width: 12 }))
  expect(await frame()).toContain("flowchart")
  await act(async () => update({ content: diagram, width: 80 }))
  expect(await frame()).not.toContain("flowchart")
})

// @card C-0078
test("unsupported, invalid, and excessive Mermaid stays readable alongside prose", async () => {
  const content = "```mermaid\npie\n\"Work\" : 20\n```\n\n```mermaid\nnonsense\n```\n\nStill readable.\n\n```mermaid\nflowchart TD\nA[" + "x".repeat(10_000) + "]\n```"
  const t = await testRender(<Markdown content={content} width={80} syntaxStyle={style} />, { width: 80, height: 160, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).toContain("pie")
  expect(frame).toContain("nonsense")
  expect(frame).toContain("Still readable.")
})

// @card C-0078
test.each([
  "flowchart TD\nA[Good] --> B[Broken",
  "flowchart TD\nA --> B; B --> C",
  "flowchart TD\nthis is nonsense",
  "flowchart TD\nA --> B\nB[Payment complete]",
  "flowchart TD\nA[\"Payment complete]",
  "flowchart TD\nA-->B",
  "stateDiagram-v2\nA --> B\nthis is nonsense",
  "stateDiagram-v2\nReady --> Done\nstate \"Failed request\" as error-state",
  "stateDiagram-v2\nReady --> Done\nDone : Finished",
  "sequenceDiagram\nAlice->>Bob: Hello\nBob->>Alice",
  "classDiagram\nAnimal <|-- Duck\nTHIS IS LOST",
  "erDiagram\nCUSTOMER ||--o{ ORDER : places\nTHIS IS LOST",
  "flowchart rl\nA --> B",
  "flowchart BT\nA[Save] --> B[Done]",
  "flowchart TD\n" + Array.from({ length: 80 }, (_, i) => `A${i}`).join(" & ") + " --> " + Array.from({ length: 80 }, (_, i) => `B${i}`).join(" & "),
])("keeps unsupported or excessive graph syntax as source: %s", async (source) => {
  const start = performance.now()
  const t = await testRender(<Markdown content={"```mermaid\n" + source + "\n```"} width={120} syntaxStyle={style} />, { width: 120, height: 24, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain(source.split("\n")[0]!)
  expect(performance.now() - start).toBeLessThan(1000)
})

// @card C-0077
test.each([
  ["stateDiagram-v2", "[*] --> Ready\nReady --> Done"],
  ["sequenceDiagram", "Alice->>Bob: Hello"],
  ["classDiagram", "Animal <|-- Duck"],
  ["erDiagram", "CUSTOMER ||--o{ ORDER : places"],
])("renders a supported %s fence", async (header, body) => {
  const t = await testRender(<Markdown content={"```mermaid\n" + header + "\n" + body + "\n```"} width={120} syntaxStyle={style} />, { width: 120, height: 40, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame.trim().length).toBeGreaterThan(0)
  expect(frame).not.toContain(header)
})

test("a gherkin fence is highlighted with the host's colours: keywords, ids, comments; the text is unchanged", async () => {
  const colours = { keyword: "#ff0000", id: "#00ff00", comment: "#0000ff" }
  const src = "```gherkin\nC-0001 Operator answers\n  Given the question is shown  # S-0001\n```"
  const t = await testRender(<Markdown content={src} width={60} syntaxStyle={style} highlight={colours} />, { width: 60, height: 10, exitOnCtrlC: false, exitSignals: [] })
  destroy = () => t.renderer.destroy()
  await t.renderOnce(); await Bun.sleep(20); await t.renderOnce()
  expect(t.captureCharFrame()).toContain("Given the question is shown  # S-0001")
  const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
  const fgOf = (word: string) => t.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes(word))
  expect(hex(fgOf("Given")!.fg)).toBe("#ff0000")
  expect(hex(fgOf("C-0001")!.fg)).toBe("#00ff00")
  expect(hex(fgOf("# S-0001")!.fg)).toBe("#0000ff")
})
