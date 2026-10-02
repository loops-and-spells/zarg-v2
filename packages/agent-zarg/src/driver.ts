import { Effect } from "effect"
import type { Bound, ServiceFailure } from "@zarg/kernel"
import { type Asker, confirmQuestion } from "@zarg/rlm"

const ASK_FIRST: ServiceFailure = {
  _tag: "AskFirst",
  message:
    "Requirements change only with the developer's say: show the exact change with Inquire.confirm({ change }) (each card as By / Given / When / Then lines; every card names who acts in it with by, a persona), then write it once they add it. Any other question closes writes again.",
}

/**
 * The driver's rule for the graph: nothing is written that the operator did not see. One guard per driver
 * item: graph writes open when the operator adds a change shown with Inquire.confirm (or the driver adds a
 * discussed one for them), and close at the next question.
 */
// @card S-0009
export const askFirst = (asker: Asker) => {
  let open = false
  const touched = new Set<string>()
  // A fix opens writes only for its finding: these ids (and what the writes add), reported to onTouched.
  let scope: { readonly allowed: Set<string>; readonly onTouched: (ids: ReadonlyArray<string>) => void } | undefined
  // Confirm questions under discussion: choosing "add" on one of them opens writes.
  const confirms = new Set<string>()
  return {
    asker: {
      ask: (question) => Effect.suspend(() => ((open = false), (scope = undefined), asker.ask(question))),
      confirm: (c) =>
        Effect.suspend(() => {
          open = false
          scope = undefined
          return Effect.tap(asker.ask(confirmQuestion(c)), (a) =>
            Effect.sync(() => {
              if (a.interjected === true && a.question !== undefined) confirms.add(a.question)
              else open = a.choice === "add"
            }),
          )
        }),
      ...(asker.choose !== undefined
        ? { choose: (c) => Effect.tap(asker.choose!(c), () => Effect.sync(() => void ((scope = undefined), (open = confirms.has(c.question) && c.choice === "add")))) }
        : {}),
    } satisfies Asker,
    /** Open graph writes for one rehearse finding (the core checked it), until the next question. */
    openFor: (finding?: { readonly allowed: ReadonlyArray<string>; readonly onTouched: (ids: ReadonlyArray<string>) => void }) => {
      open = true
      scope = finding === undefined ? undefined : { allowed: new Set(finding.allowed), onTouched: finding.onTouched }
    },
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
                (params: unknown) => {
                  if (!open) return Effect.fail(ASK_FIRST)
                  const s = scope
                  // Opened for a finding: every node the write names must be the finding's (or one this fix added).
                  const named = JSON.stringify(params).match(/\b[A-Za-z]+-\d{4,}\b/g) ?? []
                  const outside = s === undefined ? [] : named.filter((id) => !s.allowed.has(id))
                  if (outside.length > 0) {
                    return Effect.fail({ _tag: "OutsideFinding", message: `this fix may change only its finding's card and states; ${outside.join(", ")} need Inquire.confirm` })
                  }
                  return Effect.tap(h(params), (r) =>
                    Effect.sync(() => {
                      const c = r as { added?: ReadonlyArray<string>; changed?: ReadonlyArray<string>; removed?: ReadonlyArray<string> }
                      const ids = [...(c?.added ?? []), ...(c?.changed ?? []), ...(c?.removed ?? [])]
                      for (const id of ids) touched.add(id)
                      for (const id of c?.added ?? []) s?.allowed.add(id)
                      if (s !== undefined && ids.length > 0) s.onTouched(ids)
                    }),
                  )
                },
              ]),
            ),
          },
  }
}
