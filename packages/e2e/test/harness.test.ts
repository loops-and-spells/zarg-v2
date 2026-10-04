import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli, preflight, world, zarg } from "../src"

// @scenario S-0114
test("a world is a fresh git project with its own user dir and home; disposed after a pass", () => {
  const w = world({ "README.md": "hi\n" })
  expect(existsSync(join(w.project, ".git"))).toBe(true)
  expect(readFileSync(join(w.project, "README.md"), "utf8")).toBe("hi\n")
  expect(w.env.ZARG_USER_DIR).toBe(w.userDir)
  expect(w.env.HOME).toBe(w.home)
  expect(Object.keys(w.env).sort()).toEqual(["GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME", "HOME", "PATH", "TERM", "ZARG_USER_DIR"])
  w.dispose(false)
  expect(existsSync(w.project)).toBe(false)
})

test("cli runs zarg in the world and parses its JSON", async () => {
  const w = world()
  const r = await cli(w, ["agenda"])
  expect(r.code).toBe(0)
  expect(Array.isArray(r.json)).toBe(true)
  w.dispose(false)
}, 60_000)

test("the real TUI on a PTY: the Setup sheet appears in a new project; keys reach it; the cast records it", async () => {
  const w = world()
  const t = await zarg(w)
  await t.waitFor("not set up", 30_000)
  expect(t.screen()).toContain("zarg-router")
  t.press("esc")
  const code = await t.exit()
  expect(code).toBe(0)
  const cast = t.cast().trim().split("\n")
  expect(JSON.parse(cast[0]!)).toMatchObject({ version: 2, width: 120, height: 40 })
  expect(cast.length).toBeGreaterThan(2)
  w.dispose(false)
}, 60_000)

test("the preflight fails with its message when nothing listens", async () => {
  await expect(preflight("http://127.0.0.1:9/api/v1", ["deepseek-v4.1-flash-exl3"])).rejects.toThrow("zarg-router at http://127.0.0.1:9/api/v1 does not list deepseek-v4.1-flash-exl3: start the router and load it")
})

test("choose picks an option by its label, and waitGone waits for the question to leave", async () => {
  const w = world()
  const t = await zarg(w)
  await t.waitFor("Plugin backlog wants to load", 30_000)
  await t.choose("Not now")
  await t.waitGone("Plugin backlog wants to load", 10_000)
  await t.exit()
  w.dispose(false)
}, 60_000)
