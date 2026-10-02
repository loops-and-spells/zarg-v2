// packages/core/test/rehearse-calibration.test.ts
import { expect, test } from "bun:test"
import cases from "../calibration/rehearse.json"
import { scoreCalibration, type CalibrationCase } from "../src/calibration"

test("the calibration set has good and bad steps for every flag", () => {
  const set = cases as ReadonlyArray<CalibrationCase>
  expect(set.length).toBeGreaterThanOrEqual(14)
  for (const r of ["feel", "fail", "fork", "seam"]) expect(set.some((c) => c.expect.includes(r as never))).toBe(true)
  expect(set.some((c) => c.expect.length === 0)).toBe(true)
})

test("scoring: a threshold passes with at most one miss; a good step flagged is a miss too", () => {
  const set: ReadonlyArray<CalibrationCase> = [
    { name: "bad", persona: "p", prior: [], scene: {} as never, expect: ["fail"] },
    { name: "good", persona: "p", prior: [], scene: {} as never, expect: [] },
  ]
  expect(scoreCalibration(set, [{ feel: 2, fail: 0.9, arrive: 1, flags: ["fail"] }, { feel: 2, fail: 0.1, arrive: 1, flags: [] }]).pass).toBe(true)
  const bad = scoreCalibration([...set, { ...set[0]!, name: "bad2" }], [{ feel: 2, fail: 0.1, arrive: 1, flags: [] }, { feel: 1, fail: 0.1, arrive: 1, flags: ["feel"] }, { feel: 2, fail: 0.1, arrive: 1, flags: [] }])
  expect(bad.misses.fail).toEqual(["bad", "bad2"])
  expect(bad.misses.clean).toEqual(["good"])
  expect(bad.pass).toBe(false)
})
