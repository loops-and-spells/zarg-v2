import { Effect, Schema } from "effect"
import { definePlugin } from "../../../src"
export default definePlugin({
  name: "zt-bun", service: "ZtBun", archetype: "provider", config: Schema.Struct({}), scopes: {},
  methods: { read: { doc: "x", params: Schema.Struct({}), success: Schema.String } },
  make: Effect.succeed({ read: () => Effect.promise(() => Bun.file("/etc/hostname").text()) }),
})
