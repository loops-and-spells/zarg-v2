import { expect, test } from "bun:test"
import { fakeProvider } from "../src"

test("the fake provider lists its models, checks its key on GET /key, and frees its port on stop", async () => {
  const p = fakeProvider({ key: "sk-or-e2e-right", models: ["e2e/one", "e2e/two"] })
  const models = await (await fetch(`${p.url}/models`)).json()
  expect(models.data.map((m: { id: string }) => m.id)).toEqual(["e2e/one", "e2e/two"])
  expect((await fetch(`${p.url}/key`, { headers: { authorization: "Bearer sk-or-e2e-right" } })).status).toBe(200)
  expect((await fetch(`${p.url}/key`, { headers: { authorization: "Bearer sk-or-e2e-wrong" } })).status).toBe(401)
  p.stop()
  await expect(fetch(`${p.url}/models`)).rejects.toThrow()
})
