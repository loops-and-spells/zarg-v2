import { Effect } from "effect"
import type { Bound, ServiceFailure } from "@zarg/kernel"
import type { Asker } from "@zarg/rlm"

const ASK_FIRST: ServiceFailure = {
  _tag: "AskFirst",
  message:
    "Requirements change only with the developer's say: propose the change with Inquire.ask (options, one recommended, with why), then write what they chose.",
}

/**
 * The driver's rule for the graph: no write without an answered question. One guard per driver item: its
 * asker marks the item answered, and gated services refuse every call until then.
 */
export const askFirst = (asker: Asker) => {
  let answered = false
  return {
    asker: { ask: (question) => Effect.tap(asker.ask(question), () => Effect.sync(() => void (answered = true))) } satisfies Asker,
    gate: (bound: Bound | undefined): Bound | undefined =>
      bound === undefined
        ? undefined
        : {
            def: bound.def,
            handlers: Object.fromEntries(
              Object.entries(bound.handlers).map(([name, h]) => [name, (params: unknown) => (answered ? h(params) : Effect.fail(ASK_FIRST))]),
            ),
          },
  }
}
