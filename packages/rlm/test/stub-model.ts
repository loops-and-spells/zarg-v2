import { Effect, Layer, Stream } from "effect"
import { type ChatMessage, Model, type StreamEvent } from "@zarg/model"

/** One scripted reply: a cell to run, plain text, or a function of the conversation so far. */
export type Reply = { readonly cell: string } | { readonly text: string } | ((messages: ReadonlyArray<ChatMessage>) => { readonly cell: string } | { readonly text: string })

const events = (r: { cell: string } | { text: string }, n: number): ReadonlyArray<StreamEvent> =>
  "cell" in r
    ? [
        { type: "toolCall", call: { id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code: r.cell }) } } },
        { type: "usage", usage: { promptTokens: 100, completionTokens: 10, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 100 } },
        { type: "done", finishReason: "tool_calls" },
      ]
    : [{ type: "text", delta: r.text }, { type: "done", finishReason: "stop" }]

/**
 * A Model that replays scripts keyed by preset (read from the system prompt's first line).
 * Records every request so tests can inspect what each RLM saw.
 */
export const stubModel = (scripts: Readonly<Record<string, ReadonlyArray<Reply>>>) => {
  const seen: Array<{ preset: string; messages: ReadonlyArray<ChatMessage> }> = []
  const cursor = new Map<string, number>()
  const service: Model.Model["Service"] = {
    client: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
    stream: (req) => {
      // Structured-output requests are plan requests.
      const preset = req.outputSchema !== undefined ? "plan" : (/zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1] ?? "?")
      seen.push({ preset, messages: [...req.messages] })
      const i = cursor.get(preset) ?? 0
      cursor.set(preset, i + 1)
      const script = scripts[preset] ?? []
      const r = script[Math.min(i, script.length - 1)]
      if (r === undefined) return Stream.fromIterable(events({ text: "(no script)" }, i))
      return Stream.fromIterable(events(typeof r === "function" ? r(req.messages) : r, i))
    },
  }
  return { layer: Layer.succeed(Model.Model, service), service, seen }
}
