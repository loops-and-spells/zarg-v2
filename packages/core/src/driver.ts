import { Effect } from "effect"
import type { Bound, ServiceFailure } from "@zarg/kernel"
import { type Asker, confirmQuestion } from "@zarg/rlm"

const ASK_FIRST: ServiceFailure = {
  _tag: "AskFirst",
  message:
    "Requirements change only with the developer's say: show the exact change with Inquire.confirm({ change }) (each card as Given / When / Then lines), then write it once they add it. Any other question closes writes again.",
}

/**
 * The driver's rule for the graph: nothing is written that the developer did not see. One guard per driver
 * item: graph writes open when the developer adds a change shown with Inquire.confirm (or the driver adds a
 * discussed one for them), and close at the next question.
 */
export const askFirst = (asker: Asker) => {
  let open = false
  const touched = new Set<string>()
  // Confirm questions under discussion: choosing "add" on one of them opens writes.
  const confirms = new Set<string>()
  return {
    asker: {
      ask: (question) => Effect.suspend(() => ((open = false), asker.ask(question))),
      confirm: (c) =>
        Effect.suspend(() => {
          open = false
          return Effect.tap(asker.ask(confirmQuestion(c)), (a) =>
            Effect.sync(() => {
              if (a.interjected === true && a.question !== undefined) confirms.add(a.question)
              else open = a.choice === "add"
            }),
          )
        }),
      ...(asker.choose !== undefined
        ? { choose: (c) => Effect.tap(asker.choose!(c), () => Effect.sync(() => void (open = confirms.has(c.question) && c.choice === "add"))) }
        : {}),
    } satisfies Asker,
    /** Open graph writes for one rehearse finding (the core checked it), until the next question. */
    openFor: () => void (open = true),
    /** Node ids the gated writes added, changed or removed in this item. */
    touched: (): ReadonlySet<string> => touched,
    gate: (bound: Bound | undefined): Bound | undefined =>
      bound === undefined
        ? undefined
        : {
            def: bound.def,
            handlers: Object.fromEntries(
              Object.entries(bound.handlers).map(([name, h]) => [
                name,
                (params: unknown) =>
                  open
                    ? Effect.tap(h(params), (r) =>
                        Effect.sync(() => {
                          const c = r as { added?: ReadonlyArray<string>; changed?: ReadonlyArray<string>; removed?: ReadonlyArray<string> }
                          for (const id of [...(c?.added ?? []), ...(c?.changed ?? []), ...(c?.removed ?? [])]) touched.add(id)
                        }),
                      )
                    : Effect.fail(ASK_FIRST),
              ]),
            ),
          },
  }
}
