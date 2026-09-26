import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** What `.zarg/run/core.json` records about a running core. Core writes it; clients read it. */
export interface CoreInfo {
  readonly pid: number
  readonly socket: string
  readonly token: string
  readonly mode: "child" | "headless"
  readonly owner?: number
  /** Set once the core serves its socket. Until then the pid holds the project but cannot be reached. */
  readonly ready?: boolean
}

export const runDir = (root: string) => join(root, ".zarg", "run")
export const infoPath = (root: string) => join(runDir(root), "core.json")

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The live core holding this project, ready or still starting (a stale file from a dead core is ignored). */
export const readClaim = (root: string): CoreInfo | undefined => {
  if (!existsSync(infoPath(root))) return undefined
  try {
    const info = JSON.parse(readFileSync(infoPath(root), "utf8")) as CoreInfo
    return isAlive(info.pid) ? info : undefined
  } catch {
    return undefined
  }
}

/** The running core for this project once it serves its socket, or undefined. */
export const readInfo = (root: string): CoreInfo | undefined => {
  const info = readClaim(root)
  return info?.ready === true ? info : undefined
}
