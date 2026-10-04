import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Capture, Evidence, Json, Media } from "./index"

/** One attempt's media, staged beside the evidence until commit: a run killed mid-step leaves the last evidence whole. */
export interface Staged {
  readonly dir: string
  readonly attach: (c: Capture) => Media
  readonly media: () => ReadonlyArray<Media>
}

const stagingPrefix = (scenario: string) => `.${scenario}.`

/** Stages one attempt's captures; each capture's files are numbered by the order it was attached. */
export const stage = (evidenceDir: string, scenario: string, attempt: string): Staged => {
  const dir = join(evidenceDir, "media", `${stagingPrefix(scenario)}${process.pid}.${attempt}`)
  mkdirSync(dir, { recursive: true })
  const media: Array<Media> = []
  return {
    dir,
    attach: (c) => {
      const n = media.length + 1
      const names = Object.keys(c.files)
      if (names.length === 0) throw new Error(`capture "${c.caption}" has no files`)
      const bad = names.find((n) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))
      if (bad !== undefined) throw new Error(`capture "${c.caption}": file "${bad}" is not a file name`)
      for (const name of names) writeFileSync(join(dir, `${n}-${name}`), c.files[name]!)
      const at = (name: string) => `media/${scenario}/${n}-${name}`
      // A capture of several files (a trace): the first is the medium, the rest are listed for its renderer.
      const rest = names.slice(1).map(at)
      const meta: Json | undefined = rest.length === 0 ? c.meta : { ...(typeof c.meta === "object" && c.meta !== null && !Array.isArray(c.meta) ? c.meta : {}), files: rest }
      const m: Media = { kind: c.kind, caption: c.caption, path: at(names[0]!), ...(meta === undefined ? {} : { meta }) }
      media.push(m)
      return m
    },
    media: () => [...media],
  }
}

/** Staging left by runs that were killed before their commit. */
export const clearStale = (evidenceDir: string, scenario: string): void => {
  const media = join(evidenceDir, "media")
  if (!existsSync(media)) return
  for (const d of readdirSync(media)) if (d.startsWith(stagingPrefix(scenario))) rmSync(join(media, d), { recursive: true, force: true })
}

const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Swaps the staged media in (or clears the scenario's old media) and writes the evidence, JSON last. */
// @scenario S-0115
export const commit = (evidenceDir: string, staged: Staged | undefined, evidence: Evidence): void => {
  const mediaDir = join(evidenceDir, "media", evidence.scenario)
  mkdirSync(evidenceDir, { recursive: true })
  // ponytail: rm then rename is not one step; a kill between them leaves the old JSON over new media.
  rmSync(mediaDir, { recursive: true, force: true })
  if (staged !== undefined && existsSync(staged.dir)) {
    if (staged.media().length > 0) renameSync(staged.dir, mediaDir)
    else rmSync(staged.dir, { recursive: true, force: true })
  }
  writeAtomic(join(evidenceDir, `${evidence.scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
}
