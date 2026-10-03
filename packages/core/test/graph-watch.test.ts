import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchGraph } from "../src/graph-watch"

test("a burst of graph writes wakes once, after it settles; a missing dir is fine", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "zt-watch-")), "graph")
  mkdirSync(join(dir, "nodes"), { recursive: true })
  let woke = 0
  const w = watchGraph(dir, () => void woke++, 100)
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, "nodes", `S-000${i}.json`), "{}")
  await Bun.sleep(400)
  w.close()
  expect(woke).toBe(1)
  expect(() => watchGraph(join(dir, "nope"), () => {}).close()).not.toThrow()
})

test("a graph dir that does not exist yet is made and watched: the first write wakes", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "zt-watch-")), ".zarg", "graph")
  let woke = 0
  const w = watchGraph(dir, () => void woke++, 100)
  mkdirSync(join(dir, "nodes"), { recursive: true })
  writeFileSync(join(dir, "nodes", "S-0001.json"), "{}")
  await Bun.sleep(400)
  w.close()
  expect(woke).toBe(1)
})
