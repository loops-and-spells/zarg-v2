import { Data, Effect, Ref, Schema, Semaphore, Stream } from "effect"
import { bind, type Bound, defineService, Kernel, type Recorded, type ServiceFailure, tsType } from "@zarg/kernel"
import { Model, type ChatMessage, type ToolCall } from "@zarg/model"
import type { Decisions } from "@zarg/decisions"
import { atomize, type Atomized, type ChildResult, judgeProgress, preview, requestPlan, scopeOf, waves } from "./fold"
import { budgetOf, type Budget, type Preset, RESULTS, type RlmSettings } from "./presets"
import { describeScope, type Scope } from "./scope"

export type RlmErrorKind = "budget" | "result" | "model" | "kernel" | "spawn" | "config" | "plan"

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
  /** Enables folding: atomize with Decisions, then plan children when a task is not atomic. */
  readonly decisions?: Decisions["Service"]
  /** Overrides `settings.minConfidence` (atomize and "decision" verification). */
  readonly minConfidence?: number
  /** Of these graph ids, the ones that are no node: a child's focus must name real nodes. */
  readonly unknownIds?: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>
  /** Called synchronously for each RLM event (start, turns, atomize, plan, end). */
  readonly observe?: (event: RlmEvent) => void
}

/** What an observer (the core's activity feed) sees of RLMs as they run. */
export type RlmEvent =
  | { readonly type: "start"; readonly id: string; readonly parent: string | undefined; readonly preset: string; readonly task: string; readonly scope: Scope; readonly depth: number; readonly budget: Budget }
  | { readonly type: "turn"; readonly id: string; readonly turn: number; readonly tokens: number }
  /**
   * Where a turn's model call spent its time, sent as soon as it returns (a cell after it may wait on the
   * operator for good): until the first streamed event (mostly reading the prompt), the whole call, and tokens.
   */
  | {
      readonly type: "model"
      readonly id: string
      readonly turn: number
      readonly firstTokenMs: number
      readonly modelMs: number
      readonly promptTokens: number
      readonly completionTokens: number
      readonly reasoningTokens: number
    }
  /** What one turn did: the model's text and each cell with its result and time (for transcripts, not the UI). */
  | {
      readonly type: "step"
      readonly id: string
      readonly turn: number
      readonly text: string
      /** `cell` is the kernel cell number its records carry (absent when the cell did not run). */
      readonly cells: ReadonlyArray<{ readonly code: string; readonly ok: boolean; readonly output: string; readonly ms: number; readonly cell?: number }>
    }
  /** A service call or a read of time or randomness by one of the turn's cells (for transcripts and replay, not the UI). */
  | { readonly type: "record"; readonly id: string; readonly turn: number; readonly record: Recorded }
  | { readonly type: "atomize"; readonly id: string; readonly atomic: boolean; readonly reason: string; readonly criteria: Atomized["criteria"]; readonly ms: number }
  /**
   * How an agent draws its own row in the agents pane (agents that are not RLMs, like rehearse testers):
   * `progress` fills the bar, `text` replaces the turns.
   */
  | { readonly type: "status"; readonly id: string; readonly progress?: { readonly done: number; readonly total: number }; readonly text?: string }
  /** At its turn budget, the decision model judged whether the agent is progressing: `turns` is its budget now. */
  | { readonly type: "extend"; readonly id: string; readonly extended: boolean; readonly turns: number; readonly confidence: number; readonly reason: string; readonly ms: number }
  | { readonly type: "plan"; readonly id: string; readonly children: ReadonlyArray<{ readonly id: string; readonly preset: string; readonly dependsOn: ReadonlyArray<string> }> }
  | { readonly type: "end"; readonly id: string; readonly ok: true; readonly turns: number; readonly tokens: number }
  | { readonly type: "end"; readonly id: string; readonly ok: false; readonly kind: RlmErrorKind | "stopped"; readonly message: string }

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
// A turn's own text is notes around its cells: a model that loops on its words would fill the context (and the log) with them.
const TURN_TEXT = 4000
// ponytail: a flat cap per turn; per-preset when a preset needs longer replies.
const TURN_TOKENS = 16384
const clipText = (t: string) => (t.length <= TURN_TEXT ? t : `${t.slice(0, TURN_TEXT / 2)}\n… [${t.length - TURN_TEXT} characters of a runaway reply cut] …\n${t.slice(-TURN_TEXT / 2)}`)

/** A result's lists of strings as text, one per line (tried only when the result as given does not decode). */
export const joinLines = (v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) && x.every((s) => typeof s === "string") ? x.join("\n") : x]))
    : v

// What reads stay whole: an implementer re-read the same file for 24 turns when only the last 4 outputs did.
const KEEP_CHARS = 80_000
export const trimOld = (messages: Array<ChatMessage>, keep: number) => {
  const folded = new Set<string>()
  for (const m of messages) for (const c of m.toolCalls ?? []) if (c.function.arguments.includes("Rlm.exec")) folded.add(c.id)
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []))
  // Newest first: outputs stay whole while they fit KEEP_CHARS, and the latest `keep` always do.
  const old = new Set<number>()
  let total = 0
  for (const [n, i] of [...toolIdx].reverse().entries()) {
    total += (messages[i]!.content ?? "").length
    if (n >= keep && total > KEEP_CHARS) old.add(i)
  }
  for (const i of old) {
    const m = messages[i]!
    const c = m.content ?? ""
    if (m.toolCallId !== undefined && folded.has(m.toolCallId)) continue
    if (c.length > 600) messages[i] = { ...m, content: `${c.slice(0, 400)}\n… [older output trimmed] …` }
  }
  // A cell's own code (a file written in full) is a copy of what it wrote: shortened past the latest `keep`.
  const oldCalls = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keep)).map((i) => messages[i]!.toolCallId))
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
    const emit = (e: RlmEvent) => {
      try {
        deps.observe?.(e)
      } catch {
        // An observer must never break a run.
      }
    }
    // Gates run one at a time: they share one working tree, and one child's broken edit must not fail another's gate.
    const gates = yield* Semaphore.make(1)
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
          if (ref === undefined) return yield* new RlmError({ kind: "config", message: `no model for role "${preset.role}" (set a default with /models)` })
          const resultSchema = results[preset.result ?? "text"]
          if (resultSchema === undefined) return yield* new RlmError({ kind: "config", message: `unknown result "${preset.result}"` })
          const budget = budgetOf(preset, spec.budget)
          const id = `rlm-${++counter}`
          // @scenario S-0044
          yield* Effect.addFinalizer((exit) =>
            Effect.sync(() => {
              if (exit._tag === "Success") return
              const err = exit.cause.reasons.find((r) => r._tag === "Fail")?.error as RlmError | undefined
              emit(
                err === undefined
                  ? { type: "end", id, ok: false, kind: "stopped", message: "stopped" }
                  : { type: "end", id, ok: false, kind: err.kind, message: err.message },
              )
            }),
          )
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
                // A text given as its lines (`plan: [..]` for `plan: string`) is that text: a plan run spent its last turns on it.
                Effect.catch((e) => Effect.mapError(Schema.decodeUnknownEffect(Schema.toCodecJson(resultSchema))(joinLines(value)), () => e)),
                Effect.mapError((e): ServiceFailure => ({ _tag: "InvalidResult", message: `the result does not match ${resultType(resultSchema)}: ${e.message}` })),
                Effect.flatMap((decoded) => Ref.set(finished, { value: decoded })),
                Effect.as("done: stop now"),
              ),
            exec: (child) =>
              Effect.gen(function* () {
                // A focus of ids that are no node is an empty scope: the child could read nothing and would hand the task on.
                const focus = child.scope.graph?.focus ?? []
                const unknown = focus.length > 0 && deps.unknownIds !== undefined ? yield* deps.unknownIds(focus) : []
                if (unknown.length > 0) {
                  return yield* Effect.fail<ServiceFailure>({
                    _tag: "UnknownFocus",
                    message: `no node ${unknown.join(", ")}: give node ids from Graph.agenda, Graph.render or Graph.neighbors, or no graph focus for the whole graph`,
                  })
                }
                return yield* exec(child as RlmSpec, me).pipe(
                Effect.flatMap((o) => Schema.encodeEffect(Schema.toCodecJson(results[deps.settings.presets[child.preset]!.result ?? "text"]!))(o.value)),
                  Effect.mapError((e): ServiceFailure => ({ _tag: e._tag === "RlmError" ? "RlmError" : "InvalidResult", message: e.message })),
                )
              }),
          })
          const layer = preset.layer.filter((n) => n !== "Rlm").flatMap((n) => {
            const b = deps.services(n, spec.scope)
            return b === undefined ? [] : [b]
          })
          let turnCount = 0
          // What the progress judgment counts: each turn's cells and each service call.
          const history: Array<{ turn: number; code: string; ok: boolean; output: string }> = []
          const callLog: Array<{ turn: number; key: string; service: string }> = []
          const kernel = yield* Kernel.make({
            services: [...layer, rlmService],
            env: {},
            record: (record) => {
              if (record.kind === "call") callLog.push({ turn: turnCount, key: `${record.service}.${record.method} ${JSON.stringify(record.params)}`, service: record.service })
              emit({ type: "record", id, turn: turnCount, record })
            },
            ...(deps.cellTimeoutMs ? { timeoutMs: deps.cellTimeoutMs } : {}),
          })

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
          let started = Date.now()
          let tokens = 0
          let restarts = 0
          yield* Effect.logInfo("rlm.start").pipe(Effect.annotateLogs({ rlm: id, parent: parent?.id ?? "", preset: spec.preset, depth }))
          emit({ type: "start", id, parent: parent?.id, preset: spec.preset, task: spec.task, scope: spec.scope, depth, budget })

          const turn = Effect.gen(function* () {
            emit({ type: "turn", id, turn: ++turnCount, tokens })
            // Timed from when this turn gets the model (a sibling may hold it first).
            let started = 0
            let first: number | undefined
            const events = yield* Semaphore.withPermits(turns, 1)(
              Effect.suspend(() => {
                started = Date.now()
                return Stream.runCollect(model.stream({ model: ref, messages, tools: [EXEC_TOOL], maxTokens: TURN_TOKENS, ...(preset.reasoning === false ? { reasoning: { enabled: false } } : {}) }).pipe(Stream.tap(() => Effect.sync(() => void (first ??= Date.now())))))
              }),
            ).pipe(Effect.mapError((e) => new RlmError({ kind: "model", message: e.message })))
            const modelMs = Date.now() - started
            const firstTokenMs = (first ?? Date.now()) - started
            let text = ""
            let promptTokens = 0
            let completionTokens = 0
            let reasoningTokens = 0
            const calls: Array<ToolCall> = []
            for (const e of events) {
              if (e.type === "text") text += e.delta
              if (e.type === "toolCall") calls.push(e.call)
              if (e.type === "usage") {
                promptTokens += e.usage.promptTokens
                completionTokens += e.usage.completionTokens
                reasoningTokens += e.usage.reasoningTokens
              }
            }
            tokens += promptTokens + completionTokens
            text = clipText(text)
            emit({ type: "model", id, turn: turnCount, firstTokenMs, modelMs, promptTokens, completionTokens, reasoningTokens })
            messages.push({ role: "assistant", content: text.length > 0 ? text : null, ...(calls.length > 0 ? { toolCalls: calls } : {}) })
            const cells: Array<{ code: string; ok: boolean; output: string; ms: number; cell?: number }> = []
            const step = () => {
              for (const c of cells) history.push({ turn: turnCount, code: c.code, ok: c.ok, output: c.output })
              emit({ type: "step", id, turn: turnCount, text, cells })
            }
            if (calls.length === 0) {
              step()
              messages.push({ role: "user", content: "Use the exec tool. Finish with `yield* Rlm.done({ value })`." })
              return
            }
            for (const call of calls) {
              let code = ""
              let args: unknown
              try {
                args = JSON.parse(call.function.arguments)
              } catch {
                messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: "error: exec arguments must be JSON {\"code\": string}" })
                cells.push({ code: call.function.arguments, ok: false, output: "exec arguments must be JSON", ms: 0 })
                continue
              }
              code = String((args as { code?: unknown } | null)?.code ?? "")
              // An empty cell ran as "ok" and a driver sent 24 of them in a row: say what is missing instead.
              if (code.trim() === "") {
                const keys = args !== null && typeof args === "object" ? Object.keys(args) : []
                const said = `error: the cell is empty: exec takes {"code": "<TypeScript>"}${keys.length > 0 ? `, and it got ${keys.map((k) => `"${k}"`).join(", ")}` : ""}. Put your cell's code in "code".`
                messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: said })
                cells.push({ code: call.function.arguments, ok: false, output: said, ms: 0 })
                continue
              }
              const cellStart = Date.now()
              const r = yield* kernel.run(code)
              cells.push({ code, ok: r.ok, output: r.output, ms: Date.now() - cellStart, ...(r.cell !== undefined ? { cell: r.cell } : {}) })
              restarts = r.restarted ? restarts + 1 : 0
              if (restarts >= 2) return yield* new RlmError({ kind: "kernel", message: "the kernel died twice in a row" })
              messages.push({ role: "tool", name: "exec", toolCallId: call.id, content: `${r.ok ? "ok" : "failed"}\n${r.output}` })
            }
            step()
            trimOld(messages, deps.keepOutputs ?? 4)
          })

          // Folding: a task that is not atomic is planned into children, run in waves, verified,
          // and handed to this RLM as the `children` global before its first turn.
          const spawnable = depth >= deps.settings.maxDepth ? [] : (preset.spawns ?? [])
          if (deps.decisions !== undefined && spawnable.length > 0 && preset.atomize !== false) {
            const minConfidence = deps.minConfidence ?? deps.settings.minConfidence
            const atomizeStart = Date.now()
            const a = yield* atomize(deps.decisions, spec.task, describeScope(spec.scope), minConfidence)
            const atomizeMs = Date.now() - atomizeStart
            yield* Effect.logInfo("rlm.atomize").pipe(Effect.annotateLogs({ rlm: id, atomic: a.atomic, reason: a.reason }))
            emit({ type: "atomize", id, atomic: a.atomic, reason: a.reason, criteria: a.criteria, ms: atomizeMs })
            if (!a.atomic) {
              const choices = spawnable.map((p) => `- ${p} → ${resultType(results[deps.settings.presets[p]?.result ?? "text"] ?? Schema.String)}`)
              const plan = yield* Semaphore.withPermits(turns, 1)(requestPlan(model, ref, spec.task, describeScope(spec.scope), choices, spawnable)).pipe(
                Effect.mapError((e) => ("model" in e ? new RlmError({ kind: "model", message: e.model }) : new RlmError({ kind: "plan", message: e.plan }))),
              )
              emit({ type: "plan", id, children: plan.children.map((c) => ({ id: c.id, preset: c.preset, dependsOn: c.dependsOn })) })
              yield* Effect.logInfo("rlm.plan").pipe(
                Effect.annotateLogs({ rlm: id, children: plan.children.map((c) => `${c.id}:${c.preset}${c.dependsOn.length > 0 ? `<-${c.dependsOn.join("+")}` : ""}`).join(" ") }),
              )
              const byId = new Map<string, ChildResult>()
              for (const wave of waves(plan)!) {
                const outcomes = yield* Effect.forEach(
                  wave,
                  (c) => {
                    const inputs = c.dependsOn.map((d) => `- ${d}: ${preview(JSON.stringify(byId.get(d)), 4000)}`)
                    const task = inputs.length === 0 ? c.task : `${c.task}\n\nResults you depend on:\n${inputs.join("\n")}`
                    return runChild({ task, preset: c.preset, scope: scopeOf(c) }, me, c.id, minConfidence)
                  },
                  { concurrency: deps.settings.maxConcurrent },
                )
                for (const o of outcomes) {
                  byId.set(o.id, o)
                  yield* Effect.logInfo("rlm.child").pipe(
                    Effect.annotateLogs({ rlm: id, child: o.id, ok: o.ok, ...(o.ok ? (o.unverified ? { unverified: o.unverified } : {}) : { kind: o.kind, reason: preview(o.reason, 300) }) }),
                  )
                }
              }
              const children = plan.children.map((c) => byId.get(c.id)!)
              yield* kernel.run(`const children = ${JSON.stringify(children)}`)
              // The note stays small: ids, status and a preview. The full results are in the global.
              const summary = children.map((c) =>
                c.ok
                  ? `- ${c.id} (${c.preset}) ok${c.unverified ? ` (unverified: ${c.unverified})` : ""}: ${preview(JSON.stringify(c.value), 200)}`
                  : `- ${c.id} (${c.preset}) failed, ${c.kind}: ${preview(c.reason, 200)}`,
              )
              messages.push({
                role: "user",
                content: `This task was split into ${children.length} children. Their full results are in the global \`children\` (an array of { id, preset, ok, value } or { id, preset, ok: false, kind, reason }):\n${summary.join("\n")}\nRead what you need from \`children\`, combine it into your result, and finish with \`yield* Rlm.done({ value })\`.`,
              })
              // Time spent in children does not count against this RLM's own wall budget.
              started = Date.now()
            }
          }

          const over = () => tokens >= budget.tokens || Date.now() - started >= budget.wallMs
          // At the budget, an agent the decision model judges to be progressing gets more turns (up to extendMax times).
          let limit = budget.turns
          let extensions = 0
          const progress = () => {
            const from = turnCount - 4
            const cells = history.filter((c) => c.turn >= from)
            const recent = callLog.flatMap((c, i) => (c.turn >= from ? [{ ...c, repeated: callLog.slice(0, i).some((e) => e.key === c.key) }] : []))
            return {
              used: turnCount,
              extension: extensions,
              max: deps.settings.extendMax,
              cells,
              typecheckFailed: cells.filter((c) => c.output.startsWith("typecheck failed")).length,
              calls: recent.length,
              repeated: recent.filter((c) => c.repeated).length,
              asked: recent.filter((c) => c.service === "Inquire").length,
            }
          }
          for (let n = 1; !over(); n++) {
            if (n > limit) {
              if (deps.decisions === undefined || extensions >= deps.settings.extendMax) break
              const judgeStart = Date.now()
              const j = yield* judgeProgress(deps.decisions, spec.task, progress(), deps.minConfidence ?? deps.settings.minConfidence)
              if (j.extend) {
                extensions++
                limit += deps.settings.extendTurns
                messages.push({ role: "user", content: `You are making progress: ${deps.settings.extendTurns} more turns. Finish with \`yield* Rlm.done({ value })\`.` })
              }
              emit({ type: "extend", id, extended: j.extend, turns: limit, confidence: j.confidence, reason: j.reason, ms: Date.now() - judgeStart })
              if (!j.extend) break
            }
            yield* turn
            // Still only reading at its act-by turn (and every 3 after): told to act now (an implementer read 25 turns away,
            // twice; a driver read docs for 22 turns before one question).
            const act = preset.actBy
            if (act !== undefined && n >= act.turn && (n - act.turn) % 3 === 0 && !history.some((h) => h.ok && act.calls.some((c) => h.code.includes(c)))) {
              messages.push({ role: "user", content: `You have read enough: ${n} turns. ${act.say} In your next cell, from what you have read; read more only if that needs it.` })
            }
            const done = yield* Ref.get(finished)
            if (done !== undefined) {
              yield* Effect.logInfo("rlm.end").pipe(Effect.annotateLogs({ rlm: id, turns: n, tokens }))
              emit({ type: "end", id, ok: true, turns: n, tokens })
              return { id, value: done.value, turns: n, tokens }
            }
          }
          // Budget spent: one final turn to report what it has.
          // @scenario S-0043
          messages.push({ role: "user", content: "Your budget is exhausted. In your next cell call `yield* Rlm.done({ value })` with your best result now." })
          yield* turn
          const last = yield* Ref.get(finished)
          if (last !== undefined) {
            emit({ type: "end", id, ok: true, turns: turnCount, tokens })
            return { id, value: last.value, turns: turnCount, tokens }
          }
          return yield* new RlmError({ kind: "budget", message: `${spec.preset} did not finish within its budget (${limit} turns)` })
        }),
      )

    /** Run one planned child, then check it before its parent sees it. Failures become explicit entries. */
    const runChild = (
      spec: RlmSpec,
      parent: { readonly id: string; readonly preset: string; readonly depth: number },
      childId: string,
      minConfidence: number,
    ): Effect.Effect<ChildResult> =>
      Effect.gen(function* () {
        const preset = deps.settings.presets[spec.preset]!
        const outcome = yield* Effect.exit(exec(spec, parent))
        if (outcome._tag === "Failure") {
          const e = outcome.cause.reasons.find((r) => r._tag === "Fail")?.error as RlmError | undefined
          return { id: childId, preset: spec.preset, ok: false, kind: e?.kind === "budget" ? "budget" : "error", reason: e?.message ?? "the child failed" }
        }
        const value = yield* Schema.encodeEffect(Schema.toCodecJson(results[preset.result ?? "text"] ?? Schema.String))(outcome.value.value).pipe(Effect.option)
        if (value._tag === "None") return { id: childId, preset: spec.preset, ok: false, kind: "decode", reason: "the result could not be encoded" }
        if (preset.verify === "gate") {
          const gate = deps.services("Verify", spec.scope)
          const check = gate?.handlers["run"]
          if (check === undefined) return { id: childId, preset: spec.preset, ok: false, kind: "verify", reason: "no Verify service to gate this result" }
          const r = (yield* Semaphore.withPermits(gates, 1)(check({})).pipe(Effect.orElseSucceed(() => ({ passed: false, output: "the gate could not run" })))) as { passed: boolean; output: string }
          if (!r.passed) return { id: childId, preset: spec.preset, ok: false, kind: "verify", reason: `the verify gate failed:\n${r.output.slice(-2000)}` }
        }
        if (preset.verify === "decision" && deps.decisions !== undefined) {
          const d = yield* deps.decisions
            .decide({ state: `Task: ${preview(spec.task, 2000)}\nResult: ${preview(JSON.stringify(value.value), 4000)}`, questions: { ok: { type: "noul", instructions: "Does the result satisfy the task?" } } })
            .pipe(Effect.option)
          const a = d._tag === "Some" ? d.value.ok : undefined
          // A check that could not run keeps the child's work, marked unverified.
          if (a === undefined || a.type !== "noul") return { id: childId, preset: spec.preset, ok: true, value: value.value, unverified: "the result could not be checked" }
          if (!a.answer || a.confidence < minConfidence) {
            return { id: childId, preset: spec.preset, ok: false, kind: "verify", reason: `a check judged the result insufficient (confidence ${a.confidence.toFixed(2)})` }
          }
        }
        return { id: childId, preset: spec.preset, ok: true, value: value.value }
      })

    return { exec: (spec: RlmSpec) => exec(spec) }
  })

export type Rlm = Effect.Success<ReturnType<typeof make>>
