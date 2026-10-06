import { readFileSync } from "node:fs"
import { Effect, Layer, Stream } from "effect"
import { DecisionError, Decisions } from "@zarg/decisions"
import { Model, type StreamEvent } from "@zarg/model"

/** The model reference RLMs use in stub mode. */
export const STUB_MODEL = "stub:scripted"

/**
 * Test-only models, selected by `ZARG_CORE_STUB=<file>`: every model request runs the next cell of
 * `{ "cells": [...] }` (the last one repeats); Decisions is unavailable (every task runs directly) unless the
 * file scripts it (`decisions`).
 * Lets end-to-end tests drive a real core without a model server.
 */
export const stubLayer = (file: string) => {
  // `decisions`, when given: each yes/no question answers yes with that confidence (the ones named in `no`, no).
  // `routes`: a request whose messages hold `when` runs that route's cells instead (each route counts on its own), so
  // RLMs that run side by side (reconcile's plan and implement) each follow their own script.
  const { cells, routes = [], decisions: scripted } = JSON.parse(readFileSync(file, "utf8")) as {
    cells: ReadonlyArray<string>
    routes?: ReadonlyArray<{ readonly when: string; readonly cells: ReadonlyArray<string> }>
    decisions?: { readonly confidence?: number; readonly no?: ReadonlyArray<string> }
  }
  let next = 0
  const routeNext = routes.map(() => 0)
  let calls = 0
  const model: Model.Model["Service"] = {
    client: () => Effect.die("stub model has no client"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("stub model has no info"),
    warm: () => Effect.void,
    stream: (req) => {
      const text = req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
      const r = routes.findIndex((x) => text.includes(x.when))
      const own = r >= 0 ? routes[r]!.cells : cells
      const n = r >= 0 ? routeNext[r]!++ : next++
      const code = own[Math.min(n, own.length - 1)] ?? 'yield* Rlm.done({ value: "(no script)" })'
      const events: ReadonlyArray<StreamEvent> = [
        { type: "toolCall", call: { id: `stub-${calls++}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
        { type: "done", finishReason: "tool_calls" },
      ]
      return Stream.fromIterable(events)
    },
  }
  const decisions: Decisions["Service"] = {
    decide: (req) => {
      if (scripted === undefined) return Effect.fail(new DecisionError({ kind: "unavailable", message: "stub mode" }))
      const c = scripted.confidence ?? 0.9
      return Effect.succeed(
        Object.fromEntries(
          Object.entries(req.questions).flatMap(([k, q]) => {
            if (q.type !== "noul") return []
            const yes = !(scripted.no ?? []).includes(k)
            return [[k, { type: "noul" as const, answer: yes, probability: yes ? c : Math.round((1 - c) * 100) / 100, confidence: c }]]
          }),
        ),
      ) as never
    },
  }
  return Layer.mergeAll(Layer.succeed(Model.Model, model), Layer.succeed(Decisions, decisions))
}
