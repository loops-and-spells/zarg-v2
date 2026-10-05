import { expect, test } from "bun:test"
import { confirmQuestion } from "../src"

test("a change written with the question in front of it is asked once", () => {
  expect(confirmQuestion({ change: "Add this to the requirements? Add journey “In”." }).question).toBe("Add this to the requirements?\n\nAdd journey “In”.")
  expect(confirmQuestion({ change: "Add journey “In”." }).question).toBe("Add this to the requirements?\n\nAdd journey “In”.")
})
