import type { Reason, Screened, SceneView } from "./types"

export interface CalibrationCase {
  readonly name: string
  readonly persona: string
  readonly prior: ReadonlyArray<SceneView>
  readonly scene: SceneView
  /** The flags a bad scene must raise (any one of them counts); empty: a good scene that must raise none. */
  readonly expect: ReadonlyArray<Reason>
}

/** A bad scene raising none of its expected flags is a miss for each; a good scene raising any flag is a `clean` miss. */
export const scoreCalibration = (cases: ReadonlyArray<CalibrationCase>, results: ReadonlyArray<Screened | undefined>) => {
  const misses: Record<Reason | "clean", Array<string>> = { feel: [], fail: [], fork: [], seam: [], clean: [] }
  cases.forEach((c, i) => {
    const flags = results[i]?.flags ?? []
    if (c.expect.length === 0) {
      if (flags.length > 0) misses.clean.push(c.name)
    } else if (!c.expect.some((r) => flags.includes(r))) for (const r of c.expect) misses[r].push(c.name)
  })
  return { misses, pass: Object.values(misses).every((m) => m.length <= 1) }
}
