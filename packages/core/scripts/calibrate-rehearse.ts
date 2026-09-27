import { Effect } from "effect"
import { Decisions } from "@zarg/decisions"
import cases from "../calibration/rehearse.json"
import { liveLayer } from "../src/live"
import { type CalibrationCase, scoreCalibration } from "../src/rehearse/calibration"
import { screenStep } from "../src/rehearse/screen"
import { rehearseSettings } from "../src/rehearse/settings"

const root = process.cwd()
const set = cases as ReadonlyArray<CalibrationCase>
await Effect.runPromise(
  Effect.gen(function* () {
    const d = yield* Decisions
    const s = rehearseSettings({}, { driver: "unused" })
    const results = yield* Effect.forEach(set, (c) => screenStep((req) => d.decide(req), { name: "calibration", text: c.persona }, c.prior, c.step, s))
    set.forEach((c, i) => console.log(`${c.name.padEnd(24)} expect [${c.expect.join(",")}] got [${results[i]?.flags.join(",") ?? "unscreened"}]`))
    const score = scoreCalibration(set, results)
    console.log(JSON.stringify(score.misses))
    if (!score.pass) process.exit(1)
  }).pipe(Effect.provide(liveLayer(root)), Effect.scoped),
)
