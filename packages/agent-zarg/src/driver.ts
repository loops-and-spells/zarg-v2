import { Effect } from "effect"
import type { Bound, ServiceFailure } from "@zarg/kernel"
import { type Asker, confirmQuestion } from "@zarg/rlm"

const ASK_FIRST: ServiceFailure = {
  _tag: "AskFirst",
  message:
    "Requirements change only with the developer's say: show the exact change with Inquire.confirm({ change }) (each scenario as By / Given / When / Then lines; every scenario names who acts in it with by, a persona), then write it once they add it. An Inquire.ask option that is itself a change carries it as its `change`: picking it adds it. Any other question closes writes again.",
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]$/, "")
/** The words a write puts in the graph (titles, Whens, state and statement texts, names): what the developer must have seen. */
const wording = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.flatMap(wording) : v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? (["text", "title", "when", "name", "answer"].includes(k) ? [x] : []) : wording(x))) : []

/**
 * The driver's rule for the graph: nothing is written that the operator did not see. One guard per driver
 * item: graph writes open when the operator adds a change shown with Inquire.confirm (or the driver adds a
 * discussed one for them), and close at the next question.
 */
// @scenario S-0009
export const askFirst = (
  asker: Asker,
  versions?: (ids: ReadonlyArray<string>) => Effect.Effect<Readonly<Record<string, string | undefined>>>,
  commit?: (ids: ReadonlyArray<string>, message: string) => Effect.Effect<unknown, unknown>,
) => {
  let open = false
  // What the developer added, once written, is committed (at the next question, or when the item ends): the
  // Planner and reconcile only build on a committed graph.
  // ponytail: a node the operator also edited by hand, uncommitted, goes into the same commit.
  const unsaved = new Set<string>()
  let saving = ""
  const flush = Effect.suspend(() => {
    if (commit === undefined || unsaved.size === 0) return Effect.void
    const ids = [...unsaved]
    unsaved.clear()
    // The nodes first: the change's own first line may be a preamble ("Per your words …").
    return Effect.ignore(commit(ids, `req: ${ids.length > 6 ? `${ids.slice(0, 6).join(", ")} and ${ids.length - 6} more` : ids.join(", ")}: ${saving}`))
  })
  // @scenario S-0016
  // The versions of the nodes the change was shown about, as the developer saw them: a newer edit by another thread
  // makes the save stale (the change is shown again).
  let shown: Readonly<Record<string, string | undefined>> = {}
  // @scenario S-0009
  // The change the developer added, as shown: a write's wording must be in it (a model rewording after the yes is refused).
  let added: string | undefined
  const changes = new Map<string, string>()
  const touched = new Set<string>()
  // A fix opens writes only for its finding: these ids (and what the writes add), reported to onTouched.
  let scope: { readonly allowed: Set<string>; readonly onTouched: (ids: ReadonlyArray<string>) => void } | undefined
  // Confirm questions under discussion: choosing "add" on one of them opens writes.
  const confirms = new Set<string>()
  // A change added before a restart: writes are open for it (its wording only) from the start.
  const pre = asker.approved?.()
  if (pre !== undefined) {
    open = true
    added = pre
  }
  const write = (h: (params: unknown) => Effect.Effect<unknown, ServiceFailure>, params: unknown, named: ReadonlyArray<string>): Effect.Effect<unknown, ServiceFailure> => {
    if (added !== undefined) {
      const shownText = norm(added)
      const off = wording(params).find((w) => !shownText.includes(norm(w)))
      if (off !== undefined) return Effect.fail({ _tag: "NotShown", message: `"${off}" is not in the change the developer added: write the wording they saw, or show the new wording with Inquire.confirm` })
    }
    const s = scope
    // Opened for a finding: every node the write names must be the finding's (or one this fix added).
    const outside = s === undefined ? [] : named.filter((id) => !s.allowed.has(id))
    if (outside.length > 0) {
      return Effect.fail({ _tag: "OutsideFinding", message: `this fix may change only its finding's scenario and states; ${outside.join(", ")} need Inquire.confirm` })
    }
    return Effect.tap(h(params), (r) =>
      Effect.gen(function* () {
        const c = r as { added?: ReadonlyArray<string>; changed?: ReadonlyArray<string>; removed?: ReadonlyArray<string> }
        const ids = [...(c?.added ?? []), ...(c?.changed ?? []), ...(c?.removed ?? [])]
        // What this change itself changed is no newer edit: the nodes it was shown about move on with it.
        const mine = (c?.changed ?? []).filter((id) => id in shown)
        if (mine.length > 0 && versions !== undefined) shown = { ...shown, ...(yield* versions(mine)) }
        for (const id of ids) (touched.add(id), unsaved.add(id))
        if (ids.length > 0 && unsaved.size === ids.length) saving = (added?.split("\n")[0] ?? "a fix for a rehearse finding").slice(0, 72)
        for (const id of c?.added ?? []) s?.allowed.add(id)
        if (s !== undefined && ids.length > 0) s.onTouched(ids)
      }),
    )
  }
  return {
    asker: {
      // An option that is a change shows its exact wording with the question; picking it adds it.
      ask: (question) =>
        Effect.andThen(
          flush,
          Effect.suspend(() => {
            open = false
            scope = undefined
            shown = {}
            added = undefined
            const changing = question.options.filter((o) => o.change !== undefined)
            const shownQ = changing.length === 0 ? question : { ...question, question: `${question.question}\n\n${changing.map((o) => `${o.label}: ${o.change}`).join("\n\n")}` }
            return Effect.tap(asker.ask(shownQ), (a) =>
              Effect.sync(() => {
                const picked = changing.find((o) => o.id === a.choice && a.interjected !== true)
                if (picked !== undefined) (open = true), (added = picked.change)
              }),
            )
          }),
        ),
      confirm: (c) =>
        Effect.andThen(flush, Effect.suspend(() => {
          open = false
          scope = undefined
          shown = {}
          added = undefined
          const seen = versions === undefined || (c.about ?? []).length === 0 ? Effect.succeed({}) : versions(c.about ?? [])
          // Add with the operator's words (a reason) is what to change, not a yes.
          const asked = Effect.map(asker.ask(confirmQuestion(c)), (a) => (a.choice === "add" && (a.other ?? "").trim() !== "" ? { other: a.other! } : a))
          return Effect.tap(Effect.tap(seen, (v) => Effect.sync(() => void (shown = v))).pipe(Effect.andThen(asked)), (a) =>
            Effect.sync(() => {
              if (a.interjected === true && a.question !== undefined) (confirms.add(a.question), changes.set(a.question, c.change))
              else {
                open = a.choice === "add"
                added = open ? c.change : undefined
              }
            }),
          )
        })),
      ...(asker.choose !== undefined
        ? { choose: (c) => Effect.tap(asker.choose!(c), () => Effect.sync(() => void ((scope = undefined), (open = confirms.has(c.question) && c.choice === "add"), (added = open ? changes.get(c.question) : undefined)))) }
        : {}),
    } satisfies Asker,
    /** Open graph writes for one rehearse finding (the core checked it), until the next question. */
    openFor: (finding?: { readonly allowed: ReadonlyArray<string>; readonly onTouched: (ids: ReadonlyArray<string>) => void }) => {
      open = true
      added = undefined
      scope = finding === undefined ? undefined : { allowed: new Set(finding.allowed), onTouched: finding.onTouched }
    },
    /** Commit what was written since the last question (the item's end calls it). */
    flush,
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
                (params: unknown): Effect.Effect<unknown, ServiceFailure> => {
                  if (!open) return Effect.fail(ASK_FIRST)
                  const named = JSON.stringify(params).match(/\b[A-Za-z]+-\d{4,}\b/g) ?? []
                  const watched = named.filter((id) => id in shown)
                  if (watched.length === 0 || versions === undefined) return write(h, params, named)
                  // @scenario S-0016
                  return Effect.flatMap(versions(watched), (now) => {
                    const moved = watched.find((id) => now[id] !== shown[id])
                    if (moved === undefined) return write(h, params, named)
                    open = false
                    return Effect.fail({ _tag: "StaleNode", message: `${moved} changed since you showed the change (another thread edited it): read it again, then show the change again with Inquire.confirm` })
                  })
                },
              ]),
            ),
          },
  }
}
