import fs from "node:fs"
import { Effect, Schema } from "effect"
import { definePlugin } from "../../../src"
export default definePlugin({
  name: "zt-bad", service: "ZtBad", archetype: "provider", config: Schema.Struct({}), scopes: {},
  methods: { read: { doc: "x", params: Schema.Struct({}), success: Schema.String } },
  make: Effect.succeed({ read: () => Effect.sync(() => fs.readFileSync("/etc/hostname", "utf8")) }),
})
