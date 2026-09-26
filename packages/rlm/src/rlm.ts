import { Data, Effect, Ref, Schema, Semaphore, Stream } from "effect"
import { bind, type Bound, defineService, Kernel, type ServiceFailure, tsType } from "@zarg/kernel"
import { Model, type ChatMessage, type ToolCall } from "@zarg/model"
import { budgetOf, type Budget, type Preset, RESULTS, type RlmSettings } from "./presets"
import { describeScope, type Scope } from "./scope"

export type RlmErrorKind = "budget" | "result" | "model" | "kernel" | "spawn" | "config"

export class RlmError extends Data.TaggedError("RlmError")<{
  readonly kind: RlmErrorKind
  readonly message: string
}> {}

export interface RlmSpec {
  readonly task: string
  readonly preset: string
  readonly scope: Scope
  readonly budget?: Partial<Budget>
}

/** Builds the services an RLM's layer names ("Fs:read", "Graph", ...) for its scope. */
export type ServiceFactory = (name: string, scope: Scope) => Bound | undefined

export interface RlmDeps {
  readonly settings: RlmSettings
  readonly services: ServiceFactory
  /** Role → `provider:model` (from config `[roles]`). */
  readonly roles: Readonly<Record<string, string>>
  readonly results?: Readonly<Record<string, Schema.Codec<any, any>>>
  /** Per-cell worker deadline (time yielded on calls does not count). */
  readonly cellTimeoutMs?: number
  /** Tool outputs kept in full; older ones are trimmed. */
  readonly keepOutputs?: number
}

export interface RlmOutcome {
  readonly id: string
  readonly value: unknown
  readonly turns: number
  readonly tokens: number
}

const EXEC_TOOL = {
  name: "exec",
  description: "Run a TypeScript cell in your kernel. It is the body of a generator: `yield*` service calls, `return` a value to see it. Top-level declarations persist into later cells.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
}

const resultType = (schema: Schema.Codec<any, any>) => {
  const d = Schema.toJsonSchemaDocument(schema) as { schema: unknown; definitions?: Record<string, unknown> }
  return tsType(d.schema, d.definitions ?? {})
}

const systemPrompt = (
  spec: RlmSpec,
  preset: Preset,
  manifest: string,
  result: string,
  budget: Budget,
  depth: number,
  maxDepth: number,
  children: ReadonlyArray<string>,
) =>
  [
    preset.stance ?? `You are a zarg ${spec.preset} agent.`,
    "You work only by calling the `exec` tool with TypeScript cells. Each cell is a generator body: `const x = yield* Service.method(params)`; `return` a value to see it in the tool result. Declarations persist across cells, and older tool outputs get shortened, so keep results you need in variables.",
    children.length > 0
      ? [
          "Stay inside your scope. Work that needs files or graph nodes outside it, or reading more than a few files, goes to a child with `yield* Rlm.exec({ task, preset, scope })`: you get back only its result, which keeps your context small. A child starts fresh: put everything it needs to know in its task.",
          `Presets you may spawn and what each returns:\n${children.join("\n")}`,
        ].join("\n\n")
      : "Stay inside your scope. You cannot spawn children.",
    `When you are done, finish with \`yield* Rlm.done({ value })\` where value is: ${result}`,
    `Scope: ${describeScope(spec.scope)}`,
    `Depth: ${depth} of ${maxDepth}. Budget: ${budget.turns} turns.`,
    "Services available to your cells:",
    "```ts",
    manifest.trim(),
    "```",
  ].join("\n\n")

/**
 * Keep the latest tool outputs whole; shorten older ones so a long run stays in context.
 * Outputs of cells that folded work into a child (`Rlm.exec`) are the valuable part and stay whole.
 * Large cell arguments (a file written in full) are shortened once they are old.
 */
const trimOld = (messages: Array<ChatMessage>, keep: number) => {
  const folded = new Set<string>()
  for (const m of messages) for (const c of m.toolCalls ?? []) if (c.function.arguments.includes("Rlm.exec")) folded.add(c.id)
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []))
  const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keep)))
  for (const i of old) {
    const m = messages[i]!
    const c = m.content ?? ""
    if (m.toolCallId !== undefined && folded.has(m.toolCallId)) continue
    if (c.length > 600) messages[i] = { ...m, content: `${c.slice(0, 400)}\n… [older output trimmed] …` }
  }
  const oldCalls = new Set([...old].map((i) => messages[i]!.toolCallId))
  for (const [i, m] of messages.entries()) {
    if (m.role !== "assistant" || m.toolCalls === undefined) continue
    if (!m.toolCalls.some((c) => oldCalls.has(c.id) && c.function.arguments.length > 600 && !folded.has(c.id))) continue
    messages[i] = {
      ...m,
      toolCalls: m.toolCalls.map((c) =>
        oldCalls.has(c.id) && c.function.arguments.length > 600 && !folded.has(c.id)
          ? { ...c, function: { ...c.function, arguments: JSON.stringify({ code: `${String((JSON.parse(c.function.arguments) as { code?: unknown }).code ?? "").slice(0, 300)}\n// … [older cell trimmed] …` }) } }
          : c,
      ),
    }
  }
}

export const make = (deps: RlmDeps) =>
  Effect.gen(function* () {
    const model = yield* Model.Model
    const results = deps.results ?? RESULTS
    const turns = yield* Semaphore.make(deps.settings.maxConcurrent)
    let counter = 0

    const exec = (spec: RlmSpec, parent?: { readonly id: string; readonly preset: string; readonly depth: number }): Effect.Effect<RlmOutcome, RlmError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const preset = deps.settings.presets[spec.preset]
          if (preset === undefined) return yield* new RlmError({ kind: "spawn", message: `no preset "${spec.preset}"` })
          const depth = parent === undefined ? 0 : parent.depth + 1
          if (parent !== undefined) {
            const allowed = deps.settings.presets[parent.preset]?.spawns ?? []
            if (!allowed.includes(spec.preset)) {
              return yield* new RlmError({ kind: "spawn", message: `preset "${parent.preset}" may not spawn "${spec.preset}" (allowed: ${allowed.join(", ") || "none"})` })
            }
            if (depth > deps.settings.maxDepth) return yield* new RlmError({ kind: "spawn", message: `max depth ${deps.settings.maxDepth} reached` })
          }
          const ref = deps.roles[preset.role]
          if (ref === undefined) return yield* new RlmError({ kind: "config", message: `no model for role "${preset.role}"; set roles.${preset.role}` })
          const resultSchema = results[preset.result ?? "text"]
          if (resultSchema === undefined) return yield* new RlmError({ kind: "config", message: `unknown result "${preset.result}"` })
          const budget = budgetOf(preset, spec.budget)
          const id = `rlm-${++counter}`
          const me = { id, preset: spec.preset, depth }

          // The value handed to Rlm.done, once it decodes against the preset's result Schema.
          const finished = yield* Ref.make<{ readonly value: unknown } | undefined>(undefined)
          const RlmDef = defineService("Rlm", "Finish, or fold work into a child RLM.", {
            done: { doc: "Finish with your result (must match the result type in your instructions).", params: Schema.Struct({ value: Schema.Unknown }), success: Schema.String },
            exec: {
              doc: "Run a child RLM on a scoped task; returns only its result. preset must be one you may spawn.",
              params: Schema.Struct({ task: Schema.String, preset: Schema.String, scope: Schema.Struct({ paths: Schema.optionalKey(Schema.Array(Schema.String)), graph: Schema.optionalKey(Schema.Struct({ focus: Schema.Array(Schema.String), k: Schema.Number })), kind: Schema.optionalKey(Schema.String) }) }),
              success: Schema.Unknown,
            },
          })
          const rlmService = bind(RlmDef, {
            done: ({ value }) =>
              Schema.decodeUnknownEffect(Schema.toCodecJson(resultSchema))(value).pipe(
                Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `the result does not match ${resultType(resultSchema)}: ${e.message}` })),
                Effect.flatMap((decoded) => Ref.set(finished, { value: decoded })),
                Effect.as("done: stop now"),
              ),
            exec: (child) =>
              exec(child as RlmSpec, me).pipe(
                Effect.flatMap((o) => Schema.encodeEffect(Schema.toCodecJson(results[deps.settings.presets[child.preset]!.result ?? "text"]!))(o.value)),
                Effect.mapError((e): ServiceFailure => ({ _tag: e._tag === "RlmError" ? "RlmError" : "InvalidResult", message: e.message })),
              ),
          })
          const layer = preset.layer.filter((n) => n !== "Rlm").flatMap((n) => {
            const b = deps.services(n, spec.scope)
            return b === undefined ? [] : [b]
          })
          const kernel = yield* Kernel.make({ services: [...layer, rlmService], env: {}, ...(deps.cellTimeoutMs ? { timeoutMs: deps.cellTimeoutMs } : {}) })

          const messages: Array<ChatMessage> = [
            {
              role: "system",
              content: systemPrompt(
                spec,
                preset,
                kernel.manifest,
                resultType(resultSchema),
                budget,
                depth,
                deps.settings.maxDepth,
                depth >= deps.settings.maxDepth
                  ? []
                  : (preset.spawns ?? []).map((p) => `- ${p} → ${resultType(results[deps.settings.presets[p]?.result ?? "text"] ?? Schema.String)}`),
              ),
            },
            { role: "user", content: spec.task },
          ]
          const started = Date.now()
          let tokens = 0
          let restarts = 0
          yield* Effect.logInfo("rlm.start").pipe(Effect.annotateLogs({ rlm: id, parent: parent?.id ?? "", preset: spec.preset, depth }))

          const turn = Effect.gen(function* () {
            const events = yield* Semaphore.withPermits(turns, 1)(
              Stream.runCollect(model.stream({ model: ref, messages, tools: [EXEC_TOOL] })),
            ).pipe(Effect.mapError((e) => new RlmError({ kind: "model", message: e.message })))
            let text = ""
            const calls: Array<ToolCall> = []
            for (const e of events) {
              if (e.type === "text") text += e.delta
              if (e.type === "toolCall") calls.push(e.call)
              if (e.type === "usage") tokens += e.usage.promptTokens + e.usage.completionTokens
            }
            messages.push({ role: "assistant", content: text.length > 0 ? text : null, ...(calls.length > 0 ? { toolCalls: calls } : {}) })
            if (calls.length === 0) {
              messages.push({ role: "user", content: "Use the exec tool. Finish with `yield* Rlm.done({ value })`." })
              return
            }
            for (const call of calls) {
              let code = ""
              try {
                code = String((JSON.parse(call.function.arguments) as { code?: unknown }).code ?? "")
              } catch {
                messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: "error: exec arguments must be JSON {\"code\": string}" })
                continue
              }
              const r = yield* kernel.run(code)
              restarts = r.restarted ? restarts + 1 : 0
              if (restarts >= 2) return yield* new RlmError({ kind: "kernel", message: "the kernel died twice in a row" })
              messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: `${r.ok ? "ok" : "failed"}\n${r.output}` })
            }
            trimOld(messages, deps.keepOutputs ?? 4)
          })

          const over = () => tokens >= budget.tokens || Date.now() - started >= budget.wallMs
          for (let n = 1; n <= budget.turns && !over(); n++) {
            yield* turn
            const done = yield* Ref.get(finished)
            if (done !== undefined) {
              yield* Effect.logInfo("rlm.end").pipe(Effect.annotateLogs({ rlm: id, turns: n, tokens }))
              return { id, value: done.value, turns: n, tokens }
            }
          }
          // Budget spent: one final turn to report what it has.
          messages.push({ role: "user", content: "Your budget is exhausted. In your next cell call `yield* Rlm.done({ value })` with your best result now." })
          yield* turn
          const last = yield* Ref.get(finished)
          if (last !== undefined) return { id, value: last.value, turns: budget.turns + 1, tokens }
          return yield* new RlmError({ kind: "budget", message: `${spec.preset} did not finish within its budget (${budget.turns} turns)` })
        }),
      )

    return { exec: (spec: RlmSpec) => exec(spec) }
  })

export type Rlm = Effect.Success<ReturnType<typeof make>>
