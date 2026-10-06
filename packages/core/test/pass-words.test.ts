import { expect, test } from "bun:test"
import { passMessage } from "../src/phases"
import { passSummary } from "../src/reconcile"

test("a pass that built nothing says so: its commit holds plans, never a feat with no scenarios", () => {
  expect(passMessage(["S-0001", "S-0002"], [])).toBe("feat: implement S-0001, S-0002")
  expect(passMessage([], ["S-0001"])).toBe("chore: plan S-0001 (not built yet: see the findings)")
  expect(passSummary({ status: "landed", landed: [], failed: ["S-0001"], commit: "71fa0421234" } as never)).toBe("Nothing built: S-0001 need your attention (see the driver's agenda). Its plan is in 71fa042.")
  expect(passSummary({ status: "landed", landed: ["S-0002"], failed: [], commit: "abcdef0123" } as never)).toBe("Landed S-0002 in abcdef0.")
})
