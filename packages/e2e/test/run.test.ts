import { expect, test } from "bun:test"
import { run } from "../src/run"

test("the full tier needs the router's models first: nothing listening fails before any journey", async () => {
  await expect(run({ tier: "full", url: "http://127.0.0.1:9/api/v1" })).rejects.toThrow("zarg-router at http://127.0.0.1:9/api/v1 does not list deepseek-v4.1-flash-exl3: start the router and load it")
})

test("a journey that has no file is named", async () => {
  await expect(run({ tier: "fast", only: "J-9999", url: "http://127.0.0.1:9/api/v1" })).rejects.toThrow("no journey J-9999 (journeys/J-9999.test.ts)")
})
