// A pass in its own process: `CRASH_ON=<scenario>` kills the process while that scenario is being implemented.
import { runPass, stubSpec } from "./stub-spec"

const [repo, db, log] = process.argv.slice(2) as [string, string, string]
const spec = stubSpec(repo, {
  callLog: log,
  during: (item) => {
    if (process.env.CRASH_ON === item) process.exit(9)
  },
})
const out = await runPass({ ...spec, maxParallel: 1 }, db)
console.log(JSON.stringify(out))
process.exit(0)
