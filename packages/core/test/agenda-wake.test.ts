import { expect, test } from "bun:test"
import { newWork } from "../src/agenda-wake"

test("zarg wakes for agenda items it has not seen; an item gone or the same items again is no new work", () => {
  const fresh = newWork()
  expect(fresh(["gherkin:dead-end:ST-0001"])).toBe(true)
  expect(fresh(["gherkin:dead-end:ST-0001"])).toBe(false)
  expect(fresh([])).toBe(false)
  expect(fresh(["backlog:plan:B-07"])).toBe(true)
  // Back after it went: new work again.
  expect(fresh(["backlog:plan:B-07", "gherkin:dead-end:ST-0001"])).toBe(true)
})
