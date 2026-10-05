import { expect, test } from "bun:test"
import { parseModelRow } from "../src/wire/client"

test("tool calls: listed or not in supported_parameters; a row that lists none says nothing against them", () => {
  expect(parseModelRow({ id: "a", supported_parameters: ["tools"] }).supportsTools).toBe(true)
  expect(parseModelRow({ id: "b", supported_parameters: ["max_tokens"] }).supportsTools).toBe(false)
  expect(parseModelRow({ id: "c" }).supportsTools).toBe(true)
})
