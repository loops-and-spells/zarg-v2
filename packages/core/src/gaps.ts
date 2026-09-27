import { Effect } from "effect"
import type { Answer, DecisionRequest } from "@zarg/decisions"
import type { AgendaItem } from "@zarg/plugin/server"

// At most this many candidates are judged (in parallel, one request each).
const MAX_JUDGED = 8
// The decision model's confidence stays low even on clear cases; its probability separates them (a payment
// that can fail: 0.82; scrolling: 0.12). Measured on jevk5, 2026-09-27.
const LIKELY = 0.75

/**
 * Failure candidates worth offering: most one-way steps cannot fail, so only those a decision model finds
 * likely to fail (or branch) are kept. Each is judged on its own card: many cards in one request blur the
 * answers to a coin flip. No decision model, no candidates: the driver does not make up failure cases.
 */
export const judgeGaps = (
  decide: (req: DecisionRequest) => Effect.Effect<Readonly<Record<string, Answer>>, unknown>,
  candidates: ReadonlyArray<AgendaItem>,
) =>
  Effect.forEach(
    candidates.slice(0, MAX_JUDGED),
    (g) =>
      decide({
        state: `A user action in a product's requirements: ${g.detail}`,
        questions: { fails: { type: "noul", instructions: "Can this action fail in a way the user must see and handle (an error, a refusal, a timeout), or go another way?" } },
      }).pipe(
        Effect.map((a) => {
          const x = a.fails
          return x?.type === "noul" && x.answer && (x.probability ?? 0) >= LIKELY ? [g] : []
        }),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: MAX_JUDGED },
  ).pipe(Effect.map((kept) => kept.flat()))

/** Card ids with no `@card <id>` tag in the repo's tracked files. */
export const unbuiltCards = (root: string, cards: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const p = Bun.spawn(["git", "grep", "-h", "-o", "-E", "@card [A-Z]+-[0-9]+"], { cwd: root, env: process.env, stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    await p.exited
    const tagged = new Set(out.split("\n").map((l) => l.slice("@card ".length).trim()))
    return cards.filter((c) => !tagged.has(c))
  })
