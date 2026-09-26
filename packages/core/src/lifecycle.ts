import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type CoreInfo, infoPath, readClaim, runDir } from "@zarg/client"

/** A complete private copy of `info` next to core.json, to link or rename into place atomically. */
const staged = (root: string, info: CoreInfo) => {
  mkdirSync(runDir(root), { recursive: true })
  const tmp = `${infoPath(root)}.${info.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  return tmp
}

/**
 * Claim the project for this process, or explain who already holds it. `link` creates core.json only if it
 * does not exist, so of several cores starting at once exactly one wins.
 */
export const claim = (root: string, info: CoreInfo): { ok: true } | { ok: false; reason: string } => {
  const tmp = staged(root, info)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, infoPath(root))
        return { ok: true }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      }
      const live = readClaim(root)
      if (live !== undefined && live.pid !== info.pid) return { ok: false, reason: `a core is already running for this project (pid ${live.pid})` }
      // ponytail: two cores replacing the same stale file at once can both win; needs a crash plus a same-instant double start.
      rmSync(infoPath(root), { force: true })
    }
    return { ok: false, reason: "could not claim .zarg/run/core.json" }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Publish the socket and token: clients attach only once this is written. */
export const markReady = (root: string, info: CoreInfo) => renameSync(staged(root, { ...info, ready: true }), infoPath(root))

/** Remove core.json and the socket, unless another core holds them now. */
export const release = (root: string, pid: number) => {
  const current = readClaim(root)
  if (current === undefined || current.pid === pid) {
    rmSync(infoPath(root), { force: true })
    rmSync(join(runDir(root), "core.sock"), { force: true })
  }
}
