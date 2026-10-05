import { Effect } from "effect"
import type { Bound, ServiceFailure } from "@zarg/kernel"
import { type Answer, type Asker, confirmQuestion } from "@zarg/rlm"

const ASK_FIRST: ServiceFailure = {
  _tag: "AskFirst",
  message:
    "Requirements change only with the developer's say: show the exact change with Inquire.confirm({ change }) (each scenario as its title, then By / Given / When / Then lines; every scenario names who acts in it with by, a persona), then write it once they add it. An Inquire.ask option that is itself a change carries it as its `change`: picking it adds it. Any other question closes writes again.",
}

const NO_DRAFT = "Show a scenario change with its draft too: Inquire.confirm({ change, draft }), the draft being the gherkin tool calls that write it (add-scenario, link, …), so the checks run before the developer sees it."
const PICKED_HINT = "They picked an option that is a change: it is added. Write it now, as shown; no Inquire.confirm."

/** The change's first line; one that only heads it (ends with a colon) takes the next line too. */
const headline = (change: string | undefined) => {
  const lines = (change ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "")
  if (lines.length === 0) return undefined
  return lines[0]!.endsWith(":") && lines[1] !== undefined ? `${lines[0]} ${lines[1]}` : lines[0]
}
/** A commit subject's words: up to 72 characters, cut at a word with an ellipsis. */
const subject = (line: string) => {
  if (line.length <= 72) return line
  const cut = line.slice(0, 72)
  return `${cut.slice(0, Math.max(1, cut.lastIndexOf(" "))).trimEnd()}…`
}
// Quote marks aside: a change shows sentences quoted one by one that a write joins.
const norm = (t: string) => t.toLowerCase().replace(/["“”`]/g, "").replace(/\s+/g, " ").trim().replace(/[.!]$/, "")
/** The words a write puts in the graph (titles, Whens, state and statement texts, names): what the developer must have seen. */
const wording = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.flatMap(wording) : v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? (["text", "title", "when", "name", "answer"].includes(k) ? [x] : []) : wording(x))) : []

/**
 * The driver's rule for the graph: nothing is written that the operator did not see. One guard per driver
 * item: graph writes open when the operator adds a change shown with Inquire.confirm (or the driver adds a
 * discussed one for them), and close at the next question.
 */
// @scenario S-0009
/** A node as the gate compares it: its props and edges. */
export type NodeView = { readonly props: Readonly<Record<string, unknown>>; readonly edges: ReadonlyArray<{ readonly type: string; readonly to: string }> }
/** What another thread changed in a node: its prop names, and `edge:<type>` for edges added or removed. */
const changedParts = (a: NodeView, b: NodeView) => {
  const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)])
  const props = [...keys].filter((k) => JSON.stringify(a.props[k]) !== JSON.stringify(b.props[k]))
  const edge = (n: NodeView) => new Set(n.edges.map((e) => `edge:${e.type.split("/").at(-1)}>${e.to}`))
  const ea = edge(a)
  const eb = edge(b)
  const edges = [...new Set([...[...ea].filter((x) => !eb.has(x)), ...[...eb].filter((x) => !ea.has(x))].map((x) => x.split(">")[0]!))]
  return [...props, ...edges]
}
/** The parts a write sets: its params but the id (an edge's by its type). */
const touchedParts = (params: unknown) => {
  const p = (params ?? {}) as Record<string, unknown>
  return Object.keys(p).flatMap((k) => (k === "id" ? [] : k === "edge" ? [`edge:${String(p.edge)}`] : [k]))
}

export const askFirst = (
  asker: Asker,
  versions?: (ids: ReadonlyArray<string>) => Effect.Effect<Readonly<Record<string, string | undefined>>>,
  commit?: (ids: ReadonlyArray<string>, message: string) => Effect.Effect<unknown, unknown>,
  nodes?: (ids: ReadonlyArray<string>) => Effect.Effect<Readonly<Record<string, NodeView | undefined>>>,
  dryRun?: (draft: ReadonlyArray<{ readonly tool: string; readonly params: unknown }>) => Effect.Effect<{ readonly ok: boolean; readonly problems: ReadonlyArray<string> }>,
) => {
  // The nodes the change was shown about, as they were: a newer edit to other parts of them merges.
  let shownNodes: Readonly<Record<string, NodeView | undefined>> = {}
  // Something was written since the operator added the change (an added change not written yet is owed).
  let wrote = false
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
        wrote = true
        const c = r as { added?: ReadonlyArray<string>; changed?: ReadonlyArray<string>; removed?: ReadonlyArray<string> }
        const ids = [...(c?.added ?? []), ...(c?.changed ?? []), ...(c?.removed ?? [])]
        // What this change itself added or changed is no newer edit: the nodes it was shown about move on with it.
        const mine = [...(c?.added ?? []), ...(c?.changed ?? [])].filter((id) => id in shown)
        if (mine.length > 0 && versions !== undefined) shown = { ...shown, ...(yield* versions(mine)) }
        for (const id of ids) (touched.add(id), unsaved.add(id))
        if (ids.length > 0 && unsaved.size === ids.length) saving = subject(headline(added) ?? "a fix for a rehearse finding")
        for (const id of c?.added ?? []) s?.allowed.add(id)
        if (s !== undefined && ids.length > 0) s.onTouched(ids)
      }),
    )
  }
  // Showing a change to the operator: add, change or skip.
  const confirmIt = (c: Parameters<NonNullable<Asker["confirm"]>>[0]) =>
    Effect.suspend(() => {
      // The change of the option they just picked (or part of it): already added, never asked again.
      if (open && scope === undefined && added !== undefined && norm(added).includes(norm(c.change))) return Effect.succeed({ choice: "add" })
      open = false
      scope = undefined
      shown = {}
      added = undefined
      const seen = versions === undefined || (c.about ?? []).length === 0 ? Effect.succeed({}) : versions(c.about ?? [])
      shownNodes = {}
      const seenNodes = nodes === undefined || (c.about ?? []).length === 0 ? Effect.succeed({}) : nodes(c.about ?? [])
      // Add with the operator's words (a reason) is what to change, not a yes.
      const asked = Effect.map(asker.ask(confirmQuestion(c)), (a) => (a.choice === "add" && (a.other ?? "").trim() !== "" ? { other: a.other! } : a))
      return Effect.tap(Effect.tap(Effect.tap(seenNodes, (n) => Effect.sync(() => void (shownNodes = n))).pipe(Effect.andThen(seen)), (v) => Effect.sync(() => void (shown = v))).pipe(Effect.andThen(asked)), (a) =>
        Effect.sync(() => {
          if (a.interjected === true && a.question !== undefined) (confirms.add(a.question), changes.set(a.question, c.change))
          else {
            open = a.choice === "add"
            added = open ? c.change : undefined
          }
        }),
      )
    })
  return {
    asker: {
      // @scenario S-0019
      // An option that is a change shows its exact wording with the question; picking it adds it.
      ask: (question) =>
        Effect.andThen(
          flush,
          Effect.suspend(() => {
            open = false
            scope = undefined
            shown = {}
            added = undefined
            const changing = question.options.filter((o) => (o.change ?? "").trim() !== "")
            const shownQ = changing.length === 0 ? question : { ...question, question: `${question.question}\n\n${changing.map((o) => `${o.label}: ${o.change}`).join("\n\n")}` }
            return Effect.map(asker.ask(shownQ), (a) => {
              const picked = changing.find((o) => o.id === a.choice && a.interjected !== true)
              if (picked === undefined) return a
              open = true
              added = picked.change
              wrote = false
              return { ...a, hint: PICKED_HINT }
            })
          }),
        ),
      confirm: (c) =>
        Effect.andThen(flush, Effect.suspend(() => {
          // A change shown with its draft is checked first: what the checks refuse goes back to the driver, unasked.
          // A scenario change (a When line) is shown with its draft: the checks need its tool calls.
          if (dryRun !== undefined && (c.draft === undefined || c.draft.length === 0) && /^\s*When\b/im.test(c.change))
            return Effect.succeed({ problems: [NO_DRAFT] } as Answer)
          if (c.draft !== undefined && c.draft.length > 0 && dryRun !== undefined)
            return Effect.flatMap(dryRun(c.draft), (r) => (r.ok ? confirmIt(c) : Effect.succeed({ problems: [...r.problems] } as Answer)))
          return confirmIt(c)
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
    /** The change the operator added that nothing has written yet: the next item writes it (as shown). */
    owed: (): string | undefined => (open && scope === undefined && added !== undefined && !wrote ? added : undefined),
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
                    const before = shownNodes[moved]
                    if (nodes === undefined || before === undefined) {
                      open = false
                      return Effect.fail({ _tag: "StaleNode", message: `${moved} changed since you showed the change (another thread edited it): read it again, then show the change again with Inquire.confirm` })
                    }
                    return Effect.flatMap(nodes([moved]), (got) => {
                      const after = got[moved]
                      const theirs = after === undefined ? ["the whole node"] : changedParts(before, after)
                      const mine = touchedParts(params)
                      const both = after === undefined ? theirs : theirs.filter((k) => mine.includes(k))
                      // @scenario S-0017
                      // Their edit touched other parts: both hold. Written over theirs, and said.
                      if (both.length === 0) {
                        shown = { ...shown, [moved]: now[moved] }
                        shownNodes = { ...shownNodes, [moved]: after }
                        const said = `Merged with another edit to ${moved} (${theirs.join(", ")} changed there meanwhile): both kept.`
                        return Effect.tap(write(h, params, named), () => (asker.note === undefined ? Effect.void : asker.note(said)))
                      }
                      // @scenario S-0018
                      open = false
                      const value = (n: NodeView | undefined, k: string) => (k.startsWith("edge:") ? `its ${k.slice(5)} edges changed` : `${k}: ${JSON.stringify(n?.props[k])}`)
                      const p = (params ?? {}) as Record<string, unknown>
                      return Effect.fail({
                        _tag: "StaleNode",
                        message: `${moved} changed since you showed the change: another thread set ${both.map((k) => value(after, k)).join("; ")}; yours: ${both.map((k) => (k.startsWith("edge:") ? k : `${k}: ${JSON.stringify(p[k])}`)).join("; ")}. Ask the developer which to keep with Inquire.ask: one option per version (theirs, yours, and a merge when one fits), each option's change the exact edit it writes.`,
                      })
                    })
                  })
                },
              ]),
            ),
          },
  }
}
