import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type CoreInfo, infoPath, readInfo, runDir } from "@zarg/client"

/** Claim the project for this process, or explain who already holds it. */
export const claim = (root: string, info: CoreInfo): { ok: true } | { ok: false; reason: string } => {
  const live = readInfo(root)
  if (live !== undefined && live.pid !== info.pid) return { ok: false, reason: `a core is already running for this project (pid ${live.pid})` }
  mkdirSync(runDir(root), { recursive: true })
  writeFileSync(infoPath(root), JSON.stringify(info), { mode: 0o600 })
  chmodSync(infoPath(root), 0o600)
  return { ok: true }
}

/** Remove core.json and the socket, unless another core holds them now. */
export const release = (root: string, pid: number) => {
  const current = readInfo(root)
  if (current === undefined || current.pid === pid) {
    rmSync(infoPath(root), { force: true })
    rmSync(join(runDir(root), "core.sock"), { force: true })
  }
}
