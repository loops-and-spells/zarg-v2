import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** Run a shell command in `cwd`; throws with its output when it fails. */
export const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}${p.stdout.toString()}`)
  return p.stdout.toString().trim()
}

export const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const roots: Array<string> = []
export const cleanup = () => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }))

/** A git repo on branch `main` with one commit. */
export const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "zarg-reconcile-"))
  roots.push(root)
  sh(root, "git init -q -b main && git config user.email t@t && git config user.name t")
  write(root, "README.md", "hello\n")
  sh(root, "git add -A && git commit -qm init")
  return root
}

export const state = (id: string, text: string) => ({ id, type: "gherkin/state", props: { text }, edges: [] })
export const scenario = (id: string, arrives: string, then: string, when = "the user acts") => ({
  id,
  type: "gherkin/scenario",
  props: { title: id, when },
  edges: [{ type: "gherkin/arrives", to: arrives }, { type: "gherkin/then", to: then }],
})
export const writeNode = (root: string, node: { id: string }) => write(root, `.zarg/graph/nodes/${node.id}.json`, `${JSON.stringify(node)}\n`)
