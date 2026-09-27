import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { makeSurfaces, NAVIGATE, PANELS, type PanelInstance } from "../src/surfaces"

const open = () => Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-surf-")), (t) => t))
const panel = (plugin: string, name: string, agent: string): PanelInstance => ({ id: `${plugin}:${name}:${agent}`, plugin, agent, view: agent, name, scope: "shell", edge: "bottom", size: 1, input: "none" })
const lastPanels = (log: Awaited<ReturnType<typeof open>>) =>
  ((log.all().filter((e) => e.type === "ACTIVITY_SNAPSHOT" && e.activityType === PANELS).at(-1)?.content ?? { panels: [] }) as { panels: ReadonlyArray<{ id: string }> }).panels.map((p) => p.id)

test("panels are one snapshot; an agent's end closes its panels; navigation is an event with its time", async () => {
  const log = await open()
  const s = makeSurfaces(log, "main")
  s.openPanel(panel("rehearse", "status", "rehearse:run"))
  s.openPanel(panel("rehearse", "status", "rehearse:run"))
  s.openPanel(panel("rehearse", "status", "rehearse:t1"))
  expect(lastPanels(log)).toEqual(["rehearse:status:rehearse:run", "rehearse:status:rehearse:t1"])
  s.closeAgent("rehearse:run")
  expect(lastPanels(log)).toEqual(["rehearse:status:rehearse:t1"])
  s.closePanel("rehearse:status:rehearse:t1")
  expect(lastPanels(log)).toEqual([])
  s.navigate("tile", "rehearse:t1")
  expect(log.all().at(-1)).toMatchObject({ type: "CUSTOM", name: NAVIGATE, value: { kind: "tile", view: "rehearse:t1" } })
  expect(typeof (log.all().at(-1)!.value as { at: unknown }).at).toBe("number")
})

test("a new core starts with no panels", async () => {
  const log = await open()
  makeSurfaces(log, "main").openPanel(panel("rehearse", "status", "rehearse:run"))
  await Effect.runPromise(makeSurfaces(log, "main").announce)
  expect(lastPanels(log)).toEqual([])
})
