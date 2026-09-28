import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Findings the operator applied in the agents pane, per plugin: kept by the core, so a plugin's own word never opens writes. */
export const chosenFindings = (dir: string) => {
  const file = join(dir, "chosen.json")
  const read = (): Record<string, ReadonlyArray<string>> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, ReadonlyArray<string>>) : {}
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, ReadonlyArray<string>>) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(all))
  }
  return {
    add: (plugin: string, ids: ReadonlyArray<string>) => {
      const all = read()
      write({ ...all, [plugin]: [...new Set([...(all[plugin] ?? []), ...ids])] })
    },
    has: (plugin: string, id: string) => (read()[plugin] ?? []).includes(id),
    drop: (plugin: string, ids: ReadonlyArray<string>) => {
      const all = read()
      write({ ...all, [plugin]: (all[plugin] ?? []).filter((x) => !ids.includes(x)) })
    },
  }
}
export type ChosenFindings = ReturnType<typeof chosenFindings>
