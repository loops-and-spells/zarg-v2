import { Effect, Schema } from "effect"
import { definePlugin, Http, Secrets } from "../../../src"

export default definePlugin({
  name: "zt-good",
  service: "ZtGood",
  archetype: "provider",
  config: Schema.Struct({ greeting: Schema.optionalKey(Schema.String) }),
  scopes: { net: ["example.test"], secrets: ["API_KEY"] },
  methods: {
    hello: { doc: "Say hello.", params: Schema.Struct({ who: Schema.String.annotate({ description: "Whom to greet." }) }), success: Schema.String, agents: true },
    keyLength: { doc: "Length of the granted key.", params: Schema.Struct({}), success: Schema.Number },
    ping: { doc: "Fetch the granted host.", params: Schema.Struct({}), success: Schema.Number },
  },
  make: Effect.gen(function* () {
    const secrets = yield* Secrets
    const http = yield* Http
    return {
      hello: ({ who }) => Effect.succeed(`hello ${who}`),
      keyLength: () => Effect.map(secrets.get("API_KEY"), (k) => k.length),
      ping: () => Effect.map(http.request("https://example.test/ping"), (r) => r.status),
    }
  }),
})
