import { readFileSync } from "node:fs"
import { Effect, Layer, Stream } from "effect"
import { DecisionError, Decisions } from "@zarg/decisions"
import { Model, type StreamEvent } from "@zarg/model"

/** The model reference RLMs use in stub mode. */
export const STUB_MODEL = "stub:scripted"

/**
 * Test-only models, selected by `ZARG_CORE_STUB=<file>`: every model request runs the next cell of
 * `{ "cells": [...] }` (the last one repeats), and Decisions is unavailable, so every task runs directly.
 * Lets end-to-end tests drive a real core without a model server.
 */
export const stubLayer = (file: string) => {
  const { cells } = JSON.parse(readFileSync(file, "utf8")) as { cells: ReadonlyArray<string> }
  let next = 0
  const model: Model.Model["Service"] = {
    client: () => Effect.die("stub model has no client"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("stub model has no info"),
    warm: () => Effect.void,
    stream: () => {
      const n = next++
      const code = cells[Math.min(n, cells.length - 1)] ?? 'yield* Rlm.done({ value: "(no script)" })'
      const events: ReadonlyArray<StreamEvent> = [
        { type: "toolCall", call: { id: `stub-${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
        { type: "done", finishReason: "tool_calls" },
      ]
      return Stream.fromIterable(events)
    },
  }
  const decisions: Decisions["Service"] = {
    decide: () => Effect.fail(new DecisionError({ kind: "unavailable", message: "stub mode" })),
  }
  return Layer.mergeAll(Layer.succeed(Model.Model, model), Layer.succeed(Decisions, decisions))
}
