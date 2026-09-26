import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** What `.zarg/run/core.json` records about a running core. Core writes it; clients read it. */
export interface CoreInfo {
  readonly pid: number
  readonly socket: string
  readonly token: string
  readonly mode: "child" | "headless"
  readonly owner?: number
}

export const runDir = (root: string) => join(root, ".zarg", "run")
export const infoPath = (root: string) => join(runDir(root), "core.json")

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The running core for this project, or undefined (a stale file from a dead core is ignored). */
export const readInfo = (root: string): CoreInfo | undefined => {
  if (!existsSync(infoPath(root))) return undefined
  try {
    const info = JSON.parse(readFileSync(infoPath(root), "utf8")) as CoreInfo
    return isAlive(info.pid) ? info : undefined
  } catch {
    return undefined
  }
}
