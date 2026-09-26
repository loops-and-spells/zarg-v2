# Phase 2b-1a: Core Process and Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `zarg-core` process per project that runs driver threads on RLMs and speaks AG-UI over a unix socket, and `@zarg/client`, which starts or attaches to that core, streams its events and folds them into thread state for a UI.

**Architecture:** RLMs report their lifecycle to an `observe` callback. A thread runs a loop of driver RLMs (one per agenda item); the driver's `Inquire.ask` parks the cell and ends the current AG-UI run with an interrupt, and the next run's `resume` answers it. Every event goes through one log (redacted, sequence-numbered, appended to `.zarg/threads/<id>.jsonl`, published live). An Effect `HttpRouter` app, served by `BunHttpServer` on `.zarg/run/core.sock`, serves `/runs`, `/stream`, `/threads` and `/threads/:id/stop` with a bearer-token middleware (token from `.zarg/run/core.json`); `Threads`, `Log` and `Token` are services. The client reads `core.json`, attaches or spawns a child core, parses SSE into an Effect `Stream`, and a pure `reduce` turns events into `ThreadState`.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117` (`effect/unstable/http` `HttpRouter`, `@effect/platform-bun` `BunHttpServer` and `BunRuntime`), `@ag-ui/core` 1.0.0 (types and zod schemas), `@zarg/rlm`, `@zarg/model`, `@zarg/plugin`.

**Spec:** `docs/superpowers/specs/2026-09-26-core-driver-tui-design.md` (all sections except "Client and TUI"'s OpenTUI app, which is plan 2b-1b).

## Global Constraints

- Run bun only as `mise x -- bun ...` (and `mise x -- bunx ...`). Tests spawn `process.execPath`, never a bare `bun`.
- No real model in `mise run verify`: tests use a stub `Model` or a scripted driver.
- `@zarg/client` never imports `@zarg/core` or any `/server` subpath (a boundary test enforces it).
- Every event payload passes through the log's `redact` before it is stored or sent.
- `.zarg/run/core.json` is written with mode 0600. A core refuses to start while `core.json` names another live pid (exit code 2).
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every code block was prototyped and passes (`mise run verify` green on the prototype).

### Deliberate differences from the spec

- `RunAgentInput` is validated with `@ag-ui/core`'s zod schema, not an Effect Schema copy: AG-UI's own schema is the contract.
- `core.json` helpers (`CoreInfo`, `readInfo`, `isAlive`, `infoPath`, `runDir`) live in `@zarg/client`: the file is the contract both sides read. Core imports them and adds `claim`/`release`.
- The RLM tree shows the **atomize** decisions, with each criterion's answer and confidence. A failed "decision" verification of a child shows in that child's `failed` status and error text.
- A message typed while the driver works, with no question pending, ends the open run (`RUN_FINISHED` for it) and joins the recent conversation the next driver item sees. It does not interrupt the running RLM; stop does.
- `.zarg/threads/` (the thread logs) is gitignored with `.zarg/run/`.
- The CLI commands (`zarg`, `zarg core start --headless`, `zarg core stop`) come in plan 2b-1b. This plan provides `connect`, `startHeadless` and `stopCore` in `@zarg/client` for them.

## Review Focus

1. A client that disconnects mid-run (the TUI closes) must not stop the thread; the next run must still get the pending inquiry (Task 5 test).
2. A message typed while the driver works must end the open run, never leave a client's stream hanging; the next driver item sees the message (Task 4 test).
3. A core killed with SIGKILL leaves `core.json` and the socket file behind; the next core must start (Task 6 test).
4. An SSE event split across network chunks, or interleaved with comment lines, must parse (Task 2 test).
5. Events replayed after a reconnect (`/stream?since=` an older seq) must not duplicate messages in `ThreadState` (Task 3 test).

---

### Task 1: RLM activity events

**Files:**
- Modify: `packages/rlm/src/rlm.ts`, `packages/rlm/src/fold.ts`, `packages/rlm/src/services/io.ts`
- Test: `packages/rlm/test/rlm.test.ts`, `packages/rlm/test/fold.test.ts`

**Interfaces:**
- Produces: `RlmDeps.observe?: (event: RlmEvent) => void`; `Rlm.RlmEvent` (union below); `Atomized.criteria: ReadonlyArray<{ name: string; answer: boolean; confidence: number }>`; `Answer.interjected?: boolean` (Inquire answers).

```ts
export type RlmEvent =
  | { type: "start"; id; parent: string | undefined; preset; scope: Scope; depth; budget: Budget }
  | { type: "turn"; id; turn: number; tokens: number }
  | { type: "atomize"; id; atomic: boolean; reason: string; criteria: Atomized["criteria"] }
  | { type: "plan"; id; children: ReadonlyArray<{ id; preset; dependsOn }> }
  | { type: "end"; id; ok: true; turns; tokens }
  | { type: "end"; id; ok: false; kind: RlmErrorKind | "stopped"; message: string }
```

- [ ] **Step 1: Write the failing tests**

Apply this patch to the tests (`git apply` from the repo root, or edit by hand):

```diff
--- a/packages/rlm/test/rlm.test.ts
+++ b/packages/rlm/test/rlm.test.ts
@@ -97,6 +97,36 @@
   })
 })
 
+describe("observe", () => {
+  test("reports start, turns and end for each RLM, including children and failures", async () => {
+    const events: Array<Rlm.RlmEvent> = []
+    const stub = stubModel({
+      driver: [{ cell: 'return yield* Rlm.exec({ task: "find", preset: "research", scope: {} })' }, { cell: 'yield* Rlm.done({ value: "ok" })' }],
+      research: [{ cell: 'yield* Rlm.done({ value: { findings: [], sources: [] } })' }],
+    })
+    await Effect.runPromise(
+      Effect.gen(function* () {
+        const s = yield* settings({})
+        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, cellTimeoutMs: 5000, observe: (e) => events.push(e) })
+        yield* rlm.exec({ task: "t", preset: "driver", scope: {} })
+      }).pipe(Effect.provide(stub.layer)),
+    )
+    expect(events.map((e) => `${e.type}:${e.id}`)).toEqual(["start:rlm-1", "turn:rlm-1", "start:rlm-2", "turn:rlm-2", "end:rlm-2", "turn:rlm-1", "end:rlm-1"])
+    expect(events[2]).toMatchObject({ type: "start", id: "rlm-2", parent: "rlm-1", preset: "research", depth: 1 })
+    expect(events.at(-1)).toMatchObject({ type: "end", ok: true, turns: 2 })
+
+    const failed: Array<Rlm.RlmEvent> = []
+    await Effect.runPromise(
+      Effect.gen(function* () {
+        const s = yield* settings({})
+        const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m" }, observe: (e) => failed.push(e) })
+        yield* Effect.exit(rlm.exec({ task: "t", preset: "research", scope: {}, budget: { turns: 1 } }))
+      }).pipe(Effect.provide(stubModel({ research: [{ cell: "return 1" }] }).layer)),
+    )
+    expect(failed.at(-1)).toMatchObject({ type: "end", ok: false, kind: "budget" })
+  })
+})
+
 describe("folding into children", () => {
   test("a child runs in its own kernel and the parent sees only its result", async () => {
     const r = await run(
--- a/packages/rlm/test/fold.test.ts
+++ b/packages/rlm/test/fold.test.ts
@@ -65,12 +65,12 @@
   return undefined
 }
 
-const run = (scripts: Record<string, ReadonlyArray<Reply>>, spec: Rlm.RlmSpec, d: ReturnType<typeof decisions>, raw: unknown = {}) => {
+const run = (scripts: Record<string, ReadonlyArray<Reply>>, spec: Rlm.RlmSpec, d: ReturnType<typeof decisions>, raw: unknown = {}, observe?: (e: Rlm.RlmEvent) => void) => {
   const stub = stubModel(scripts)
   return Effect.runPromise(
     Effect.gen(function* () {
       const s = yield* settings(raw)
-      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", sync: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000 })
+      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", sync: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000, ...(observe ? { observe } : {}) })
       return yield* Effect.exit(rlm.exec(spec))
     }).pipe(Effect.provide(stub.layer)),
   ).then((exit) => ({ exit, seen: stub.seen }))
@@ -91,6 +91,16 @@
     expect(Object.keys(d.calls[0]!.questions)).toEqual(["single", "oneExecutor", "noSteps", "noPackaging", "noCoordination"])
   })
 
+  test("the atomize event carries each criterion's answer and confidence", async () => {
+    const events: Array<Rlm.RlmEvent> = []
+    await run({ driver: [{ cell: 'yield* Rlm.done({ value: "direct" })' }] }, { task: "small", preset: "driver", scope: {} }, decisions(true), {}, (e) => events.push(e))
+    const a = events.find((e) => e.type === "atomize")
+    expect(a?.type === "atomize" && a.atomic).toBe(true)
+    expect(a?.type === "atomize" && a.criteria).toEqual(
+      ["single", "oneExecutor", "noSteps", "noPackaging", "noCoordination"].map((name) => ({ name, answer: true, confidence: 0.9 })),
+    )
+  })
+
   test("a non-atomic task is planned; children run in dependency order; the parent folds `children`", async () => {
     const plan: Plan = { children: [child("c1"), child("c2", ["c1"])] }
     const r = await run(
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/rlm && mise x -- bun test test/rlm.test.ts test/fold.test.ts`
Expected: FAIL. "observe" records no events (the option does not exist yet) and the atomize test finds no `atomize` event.

- [ ] **Step 3: Implement**

Apply this patch to the sources. The end event on failure comes from a scope finalizer, so errors, budget exhaustion and interruption (a stop) all report one. An observer that throws never breaks a run.

```diff
--- a/packages/rlm/src/rlm.ts
+++ b/packages/rlm/src/rlm.ts
@@ -2,7 +2,7 @@
 import { bind, type Bound, defineService, Kernel, type ServiceFailure, tsType } from "@zarg/kernel"
 import { Model, type ChatMessage, type ToolCall } from "@zarg/model"
 import type { Decisions } from "@zarg/decisions"
-import { atomize, type ChildResult, preview, requestPlan, scopeOf, waves } from "./fold"
+import { atomize, type Atomized, type ChildResult, preview, requestPlan, scopeOf, waves } from "./fold"
 import { budgetOf, type Budget, type Preset, RESULTS, type RlmSettings } from "./presets"
 import { describeScope, type Scope } from "./scope"
 
@@ -37,8 +37,19 @@
   readonly decisions?: Decisions["Service"]
   /** Overrides `settings.minConfidence` (atomize and "decision" verification). */
   readonly minConfidence?: number
+  /** Called synchronously for each RLM event (start, turns, atomize, plan, end). */
+  readonly observe?: (event: RlmEvent) => void
 }
 
+/** What an observer (the core's activity feed) sees of RLMs as they run. */
+export type RlmEvent =
+  | { readonly type: "start"; readonly id: string; readonly parent: string | undefined; readonly preset: string; readonly scope: Scope; readonly depth: number; readonly budget: Budget }
+  | { readonly type: "turn"; readonly id: string; readonly turn: number; readonly tokens: number }
+  | { readonly type: "atomize"; readonly id: string; readonly atomic: boolean; readonly reason: string; readonly criteria: Atomized["criteria"] }
+  | { readonly type: "plan"; readonly id: string; readonly children: ReadonlyArray<{ readonly id: string; readonly preset: string; readonly dependsOn: ReadonlyArray<string> }> }
+  | { readonly type: "end"; readonly id: string; readonly ok: true; readonly turns: number; readonly tokens: number }
+  | { readonly type: "end"; readonly id: string; readonly ok: false; readonly kind: RlmErrorKind | "stopped"; readonly message: string }
+
 export interface RlmOutcome {
   readonly id: string
   readonly value: unknown
@@ -121,6 +132,13 @@
     const model = yield* Model.Model
     const results = deps.results ?? RESULTS
     const turns = yield* Semaphore.make(deps.settings.maxConcurrent)
+    const emit = (e: RlmEvent) => {
+      try {
+        deps.observe?.(e)
+      } catch {
+        // An observer must never break a run.
+      }
+    }
     // Gates run one at a time: they share one working tree, and one child's broken edit must not fail another's gate.
     const gates = yield* Semaphore.make(1)
     let counter = 0
@@ -144,6 +162,17 @@
           if (resultSchema === undefined) return yield* new RlmError({ kind: "config", message: `unknown result "${preset.result}"` })
           const budget = budgetOf(preset, spec.budget)
           const id = `rlm-${++counter}`
+          yield* Effect.addFinalizer((exit) =>
+            Effect.sync(() => {
+              if (exit._tag === "Success") return
+              const err = exit.cause.reasons.find((r) => r._tag === "Fail")?.error as RlmError | undefined
+              emit(
+                err === undefined
+                  ? { type: "end", id, ok: false, kind: "stopped", message: "stopped" }
+                  : { type: "end", id, ok: false, kind: err.kind, message: err.message },
+              )
+            }),
+          )
           const me = { id, preset: spec.preset, depth }
 
           // The value handed to Rlm.done, once it decodes against the preset's result Schema.
@@ -197,8 +226,11 @@
           let tokens = 0
           let restarts = 0
           yield* Effect.logInfo("rlm.start").pipe(Effect.annotateLogs({ rlm: id, parent: parent?.id ?? "", preset: spec.preset, depth }))
+          emit({ type: "start", id, parent: parent?.id, preset: spec.preset, scope: spec.scope, depth, budget })
+          let turnCount = 0
 
           const turn = Effect.gen(function* () {
+            emit({ type: "turn", id, turn: ++turnCount, tokens })
             const events = yield* Semaphore.withPermits(turns, 1)(
               Stream.runCollect(model.stream({ model: ref, messages, tools: [EXEC_TOOL] })),
             ).pipe(Effect.mapError((e) => new RlmError({ kind: "model", message: e.message })))
@@ -237,11 +269,13 @@
             const minConfidence = deps.minConfidence ?? deps.settings.minConfidence
             const a = yield* atomize(deps.decisions, spec.task, describeScope(spec.scope), minConfidence)
             yield* Effect.logInfo("rlm.atomize").pipe(Effect.annotateLogs({ rlm: id, atomic: a.atomic, reason: a.reason }))
+            emit({ type: "atomize", id, atomic: a.atomic, reason: a.reason, criteria: a.criteria })
             if (!a.atomic) {
               const choices = spawnable.map((p) => `- ${p} → ${resultType(results[deps.settings.presets[p]?.result ?? "text"] ?? Schema.String)}`)
               const plan = yield* Semaphore.withPermits(turns, 1)(requestPlan(model, ref, spec.task, describeScope(spec.scope), choices, spawnable)).pipe(
                 Effect.mapError((e) => ("model" in e ? new RlmError({ kind: "model", message: e.model }) : new RlmError({ kind: "plan", message: e.plan }))),
               )
+              emit({ type: "plan", id, children: plan.children.map((c) => ({ id: c.id, preset: c.preset, dependsOn: c.dependsOn })) })
               yield* Effect.logInfo("rlm.plan").pipe(
                 Effect.annotateLogs({ rlm: id, children: plan.children.map((c) => `${c.id}:${c.preset}${c.dependsOn.length > 0 ? `<-${c.dependsOn.join("+")}` : ""}`).join(" ") }),
               )
@@ -286,6 +320,7 @@
             const done = yield* Ref.get(finished)
             if (done !== undefined) {
               yield* Effect.logInfo("rlm.end").pipe(Effect.annotateLogs({ rlm: id, turns: n, tokens }))
+              emit({ type: "end", id, ok: true, turns: n, tokens })
               return { id, value: done.value, turns: n, tokens }
             }
           }
@@ -293,7 +328,10 @@
           messages.push({ role: "user", content: "Your budget is exhausted. In your next cell call `yield* Rlm.done({ value })` with your best result now." })
           yield* turn
           const last = yield* Ref.get(finished)
-          if (last !== undefined) return { id, value: last.value, turns: budget.turns + 1, tokens }
+          if (last !== undefined) {
+            emit({ type: "end", id, ok: true, turns: budget.turns + 1, tokens })
+            return { id, value: last.value, turns: budget.turns + 1, tokens }
+          }
           return yield* new RlmError({ kind: "budget", message: `${spec.preset} did not finish within its budget (${budget.turns} turns)` })
         }),
       )
--- a/packages/rlm/src/fold.ts
+++ b/packages/rlm/src/fold.ts
@@ -16,6 +16,8 @@
   readonly atomic: boolean
   /** Why: each criterion's answer and confidence, or why the check was skipped. */
   readonly reason: string
+  /** Each criterion's answer and confidence (empty when Decisions was unavailable). */
+  readonly criteria: ReadonlyArray<{ readonly name: string; readonly answer: boolean; readonly confidence: number }>
 }
 
 /** Ask Decisions whether a task is atomic. If Decisions cannot answer, treat the task as atomic. */
@@ -26,14 +28,17 @@
     )
     const req: DecisionRequest = { state: `Task: ${task}\nScope: ${scope}`, questions }
     const answers = yield* decisions.decide(req).pipe(Effect.option)
-    if (answers._tag === "None") return { atomic: true, reason: "decisions unavailable; executing directly" } satisfies Atomized
+    if (answers._tag === "None") return { atomic: true, reason: "decisions unavailable; executing directly", criteria: [] } satisfies Atomized
     const notes = Object.entries(answers.value).map(([k, a]: [string, Answer]) =>
       a.type === "noul" ? `${k}: ${a.answer ? "yes" : "no"} (${a.confidence.toFixed(2)})` : `${k}: ?`,
     )
     // Plan only on a confident "no". A hedging model (low confidence) executes directly,
     // as ROMA's own tie-breaker does; otherwise uncertainty would plan at every level.
     const atomic = !Object.values(answers.value).some((a) => a.type === "noul" && !a.answer && a.confidence >= minConfidence)
-    return { atomic, reason: notes.join(", ") } satisfies Atomized
+    const criteria = Object.entries(answers.value).flatMap(([name, a]: [string, Answer]) =>
+      a.type === "noul" ? [{ name, answer: a.answer, confidence: a.confidence }] : [],
+    )
+    return { atomic, reason: notes.join(", "), criteria } satisfies Atomized
   })
 
 export const PlanChild = Schema.Struct({
--- a/packages/rlm/src/services/io.ts
+++ b/packages/rlm/src/services/io.ts
@@ -28,7 +28,8 @@
   about: Schema.optionalKey(Schema.Array(Schema.String)),
 })
 export type Question = typeof Question.Type
-const Answer = Schema.Struct({ choice: Schema.optionalKey(Schema.String), other: Schema.optionalKey(Schema.String) })
+/** An option id, or free text; `interjected` when the developer wrote a message instead of answering. */
+const Answer = Schema.Struct({ choice: Schema.optionalKey(Schema.String), other: Schema.optionalKey(Schema.String), interjected: Schema.optionalKey(Schema.Boolean) })
 export type Answer = typeof Answer.Type
 
 export const InquireDef = defineService("Inquire", "Ask the developer a question. The cell waits (yielded) until they answer.", {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/rlm && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/rlm
git commit -m "feat(rlm): observe hook with RLM lifecycle events and atomize confidence"
```

---

### Task 2: @zarg/client connection and transport

**Files:**
- Create: `packages/client/package.json`, `packages/client/tsconfig.json`, `packages/client/mise.toml`
- Create: `packages/client/src/info.ts`, `src/events.ts`, `src/sse.ts`, `src/client.ts`, `src/connect.ts`, `src/index.ts`
- Test: `packages/client/test/client.test.ts`, `test/connect.test.ts`, `test/fake-core.ts`, `test/boundary.test.ts`

**Interfaces:**
- Produces:
  - `CoreInfo { pid, socket, token, mode: "child" | "headless", owner? }`, `runDir(root)`, `infoPath(root)`, `isAlive(pid)`, `readInfo(root): CoreInfo | undefined`
  - `WireEvent { type: string; threadId: string; seq: number; [k]: unknown }`, `Option`, `Answer = { choice } | { other }`
  - `parseSse(body): Stream<WireEvent, Error>`
  - `makeClient({ socket, token })` → `{ run(RunRequest): Stream<WireEvent, CoreError>, stream(since): Stream<WireEvent, CoreError>, threads(): Effect<ThreadInfo[], CoreError>, stop(threadId): Effect<void, CoreError> }`; `RunRequest { threadId, focus?, message?, answer?: { interruptId, answer: Answer } }`; `runInput(RunRequest)` (the AG-UI `RunAgentInput`); `CoreError { status, message }` (status 0: unreachable)
  - `connect({ root, command, timeoutMs? }): Effect<Connection, CoreStartError>` with `Connection { info, owned, close(): Promise<void> }`; `startHeadless({ root, command }): Effect<CoreInfo, CoreStartError>`; `stopCore(root): Effect<boolean, CoreStartError>`
  - The core command line contract: `<command...> --root <root> --mode child|headless`; the core writes `core.json`, then prints `ready <socket>` on stdout; in child mode it exits when its stdin closes.

- [ ] **Step 1: Create the package**

`packages/client/package.json`:

```json
{
  "name": "@zarg/client",
  "dependencies": {
    "effect": "^4.0.0-rc.117"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "private": true,
  "type": "module"
}
```

`packages/client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/client/mise.toml`:

```toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```

Run: `mise x -- bun install`
Expected: `bun.lock` gains `@zarg/client`.

- [ ] **Step 2: Write the failing tests**

`packages/client/test/client.test.ts` (a fake core on a unix socket, so the client is tested without `@zarg/core`):

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { makeClient } from "../src"

// A fake core: records requests and answers with fixed SSE, so the client is tested without @zarg/core.
const dir = mkdtempSync(join(tmpdir(), "zarg-client-"))
const socket = join(dir, "core.sock")
const seen: Array<{ method: string; path: string; auth: string | null; body: any }> = []
const sseBody = (chunks: ReadonlyArray<string>) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x))
      c.close()
    },
  })
const server = Bun.serve({
  unix: socket,
  async fetch(req) {
    const url = new URL(req.url)
    seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : undefined })
    if (req.headers.get("authorization") !== "Bearer tok") return Response.json({ error: "unauthorized" }, { status: 401 })
    if (url.pathname === "/threads") return Response.json([{ id: "main", focus: [], status: "idle" }])
    if (url.pathname === "/threads/main/stop") return Response.json({ stopped: "main" })
    // Events split across chunks and with CRLF-free multi-line framing, as a real stream may deliver them.
    return new Response(
      sseBody(['data: {"type":"RUN_STARTED","threadId":"main","seq":1}\n\n: comment\n\ndata: {"type":"RUN_FIN', 'ISHED","threadId":"main","seq":2}\n\n']),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const client = makeClient({ socket, token: "tok" })
const collect = <A, E>(s: Stream.Stream<A, E>) => Effect.runPromise(Stream.runCollect(s)).then((c) => [...c])

describe("client", () => {
  test("a run posts an AG-UI RunAgentInput and yields the parsed SSE events", async () => {
    const events = await collect(client.run({ threadId: "main", focus: ["S-0002"], message: "hello" }))
    expect(events.map((e) => [e.type, e.seq])).toEqual([["RUN_STARTED", 1], ["RUN_FINISHED", 2]])
    const body = seen.at(-1)!.body
    expect(body).toMatchObject({ threadId: "main", forwardedProps: { focus: ["S-0002"] }, messages: [{ role: "user", content: "hello" }] })
    expect(typeof body.runId).toBe("string")
    expect(body.resume).toBeUndefined()
  })

  test("an answer becomes a resume for the interrupt", async () => {
    await collect(client.run({ threadId: "main", answer: { interruptId: "inq-1", answer: { choice: "a" } } }))
    expect(seen.at(-1)!.body.resume).toEqual([{ interruptId: "inq-1", status: "resolved", payload: { choice: "a" } }])
    expect(seen.at(-1)!.body.messages).toEqual([])
  })

  test("stream, threads and stop send the token", async () => {
    await collect(client.stream(5))
    expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/stream?since=5", auth: "Bearer tok" })
    expect(await Effect.runPromise(client.threads())).toEqual([{ id: "main", focus: [], status: "idle" }])
    await Effect.runPromise(client.stop("main"))
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/threads/main/stop" })
  })

  test("a wrong token fails with CoreError 401; a missing socket fails as unreachable", async () => {
    const bad = await Effect.runPromise(Effect.flip(makeClient({ socket, token: "nope" }).threads()))
    expect(bad).toMatchObject({ _tag: "CoreError", status: 401 })
    const gone = await Effect.runPromise(Effect.flip(makeClient({ socket: join(dir, "missing.sock"), token: "tok" }).threads()))
    expect(gone).toMatchObject({ _tag: "CoreError", status: 0 })
    expect(gone.message).toContain("not reachable")
  })
})
```

`packages/client/test/fake-core.ts` (same command line and `core.json` contract as zarg-core):

```ts
// A stand-in for zarg-core with the same command line and core.json contract. FAKE_CORE=fail exits with an error.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string" } } })
const root = values.root!
if (process.env.FAKE_CORE === "fail") {
  console.error("config error: roles.driver is not set")
  process.exit(1)
}
const run = join(root, ".zarg", "run")
mkdirSync(run, { recursive: true })
const socket = join(run, "core.sock")
const server = Bun.serve({ unix: socket, fetch: () => Response.json([]) })
writeFileSync(join(run, "core.json"), JSON.stringify({ pid: process.pid, socket, token: "t", mode: values.mode }), { mode: 0o600 })
const bye = () => {
  server.stop(true)
  rmSync(join(run, "core.json"), { force: true })
  process.exit(0)
}
process.on("SIGTERM", bye)
if (values.mode === "child") {
  process.stdin.on("end", bye)
  process.stdin.resume()
}
console.log(`ready ${socket}`)
```

`packages/client/test/connect.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { connect, isAlive, readInfo, startHeadless, stopCore } from "../src"

const command = [process.execPath, join(import.meta.dir, "fake-core.ts")]
const roots: Array<string> = []
const fresh = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-connect-"))
  roots.push(r)
  return r
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

describe("connect", () => {
  test("with no core running, starts a child core and stops it on close", async () => {
    const root = fresh()
    const c = await Effect.runPromise(connect({ root, command }))
    expect(c.owned).toBe(true)
    expect(c.info.mode).toBe("child")
    expect(isAlive(c.info.pid)).toBe(true)
    await c.close()
    expect(isAlive(c.info.pid)).toBe(false)
    expect(readInfo(root)).toBeUndefined()
  })

  test("attaches to a running core without owning it", async () => {
    const root = fresh()
    const first = await Effect.runPromise(connect({ root, command }))
    const second = await Effect.runPromise(connect({ root, command }))
    expect(second.owned).toBe(false)
    expect(second.info.pid).toBe(first.info.pid)
    await second.close()
    expect(isAlive(first.info.pid)).toBe(true)
    await first.close()
  })

  test("a core that fails to start reports its stderr", async () => {
    const root = fresh()
    process.env.FAKE_CORE = "fail"
    const err = await Effect.runPromise(Effect.flip(connect({ root, command }))).finally(() => delete process.env.FAKE_CORE)
    expect(err._tag).toBe("CoreStartError")
    expect(err.message).toContain("roles.driver is not set")
  })

  test("a headless core keeps running until stopCore", async () => {
    const root = fresh()
    const info = await Effect.runPromise(startHeadless({ root, command }))
    expect(info.mode).toBe("headless")
    expect((await Effect.runPromise(Effect.flip(startHeadless({ root, command })))).message).toContain("already running")
    expect(await Effect.runPromise(stopCore(root))).toBe(true)
    expect(isAlive(info.pid)).toBe(false)
    expect(await Effect.runPromise(stopCore(root))).toBe(false)
  })
})
```

`packages/client/test/boundary.test.ts`:

```ts
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

test("the client never imports core or any server module", () => {
  const src = join(import.meta.dir, "..", "src")
  const offenders = readdirSync(src).flatMap((f) =>
    [...readFileSync(join(src, f), "utf8").matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((spec) => spec.startsWith("@zarg/core") || spec.includes("/server"))
      .map((spec) => `${f}: ${spec}`),
  )
  expect(offenders).toEqual([])
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/client && mise x -- bun test`
Expected: FAIL (`../src` does not exist). The boundary test passes on an empty `src`; it guards later changes.

- [ ] **Step 4: Implement**

`packages/client/src/info.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** What `.zarg/run/core.json` records about a running core. Core writes it; clients read it. */
export interface CoreInfo {
  readonly pid: number
  readonly socket: string
  readonly token: string
  readonly mode: "child" | "headless"
  readonly owner?: number
}

export const runDir = (root: string) => join(root, ".zarg", "run")
export const infoPath = (root: string) => join(runDir(root), "core.json")

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The running core for this project, or undefined (a stale file from a dead core is ignored). */
export const readInfo = (root: string): CoreInfo | undefined => {
  if (!existsSync(infoPath(root))) return undefined
  try {
    const info = JSON.parse(readFileSync(infoPath(root), "utf8")) as CoreInfo
    return isAlive(info.pid) ? info : undefined
  } catch {
    return undefined
  }
}
```

`packages/client/src/events.ts`:

```ts
/** An AG-UI event as core sends it: the event plus its thread and sequence number. */
export interface WireEvent {
  readonly type: string
  readonly threadId: string
  readonly seq: number
  readonly [key: string]: unknown
}

export interface Option {
  readonly id: string
  readonly label: string
  readonly recommended?: boolean
  readonly why?: string
}

/** Answer to an inquiry: one of its options, or the developer's own text. */
export type Answer = { readonly choice: string } | { readonly other: string }
```

`packages/client/src/sse.ts`:

```ts
import { Stream } from "effect"
import type { WireEvent } from "./events"

/** Split an SSE body into its `data:` payloads, parsed as JSON. Comments and other fields are ignored. */
export const parseSse = (body: ReadableStream<Uint8Array>): Stream.Stream<WireEvent, Error> =>
  Stream.fromReadableStream({ evaluate: () => body, onError: (e) => (e instanceof Error ? e : new Error(String(e))) }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.mapAccum(
      () => [] as ReadonlyArray<string>,
      (data, line): readonly [ReadonlyArray<string>, ReadonlyArray<WireEvent>] => {
        if (line === "") return data.length === 0 ? [[], []] : [[], [JSON.parse(data.join("\n")) as WireEvent]]
        if (line.startsWith("data:")) return [[...data, line.slice(line.startsWith("data: ") ? 6 : 5)], []]
        return [data, []]
      },
    ),
  )
```

`packages/client/src/client.ts`:

```ts
import { Data, Effect, Stream } from "effect"
import type { Answer, WireEvent } from "./events"
import type { CoreInfo } from "./info"
import { parseSse } from "./sse"

export class CoreError extends Data.TaggedError("CoreError")<{ readonly status: number; readonly message: string }> {}

export interface ThreadInfo {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly status: "idle" | "running" | "waiting"
}

/** What one run sends: a new message (possibly an interjection), an answer to an inquiry, or neither (start the loop). */
export interface RunRequest {
  readonly threadId: string
  readonly focus?: ReadonlyArray<string>
  readonly message?: string
  readonly answer?: { readonly interruptId: string; readonly answer: Answer }
}

/** The AG-UI RunAgentInput for a run. Each message gets a fresh id, so core counts it as new. */
export const runInput = (r: RunRequest) => ({
  threadId: r.threadId,
  runId: crypto.randomUUID(),
  state: {},
  messages: r.message !== undefined ? [{ id: crypto.randomUUID(), role: "user", content: r.message }] : [],
  tools: [],
  context: [],
  forwardedProps: { focus: r.focus ?? [] },
  ...(r.answer !== undefined ? { resume: [{ interruptId: r.answer.interruptId, status: "resolved", payload: r.answer.answer }] } : {}),
})

/** A client for one core, over its unix socket with its token. */
export const makeClient = (info: Pick<CoreInfo, "socket" | "token">) => {
  const request = (path: string, init: RequestInit = {}) =>
    Effect.tryPromise({
      try: () =>
        fetch(`http://core${path}`, {
          ...init,
          unix: info.socket,
          headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json", ...init.headers },
        } as RequestInit),
      catch: (e) => new CoreError({ status: 0, message: `core is not reachable: ${e instanceof Error ? e.message : String(e)}` }),
    }).pipe(
      Effect.flatMap((res) =>
        res.ok
          ? Effect.succeed(res)
          : Effect.promise(() => res.text()).pipe(Effect.flatMap((text) => Effect.fail(new CoreError({ status: res.status, message: text })))),
      ),
    )

  const events = (path: string, init?: RequestInit): Stream.Stream<WireEvent, CoreError> =>
    Stream.unwrap(Effect.map(request(path, init), (res) => parseSse(res.body!))).pipe(
      Stream.mapError((e) => (e instanceof CoreError ? e : new CoreError({ status: 0, message: `core stopped: ${e.message}` }))),
    )

  return {
    /** Post a run; its events until the run finishes or fails. */
    run: (r: RunRequest) => events("/runs", { method: "POST", body: JSON.stringify(runInput(r)) }),
    /** Every thread's events after `since`, then live ones. */
    stream: (since: number) => events(`/stream?since=${since}`),
    threads: () => request("/threads").pipe(Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<ReadonlyArray<ThreadInfo>>))),
    stop: (threadId: string) => request(`/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST", body: "{}" }).pipe(Effect.asVoid),
  }
}

export type Client = ReturnType<typeof makeClient>
```

`packages/client/src/connect.ts`:

```ts
import { spawn } from "node:child_process"
import { Data, Effect } from "effect"
import { type CoreInfo, isAlive, readInfo } from "./info"

export class CoreStartError extends Data.TaggedError("CoreStartError")<{ readonly message: string }> {}

export interface Connection {
  readonly info: CoreInfo
  /** True when this process started the core as its child; the core stops when this process exits. */
  readonly owned: boolean
  /** Stop the core if this process owns it; an attached core keeps running. */
  readonly close: () => Promise<void>
}

/** Start `command --root <root> --mode <mode>`, wait for its `ready` line, or fail with its stderr. */
const start = (root: string, command: ReadonlyArray<string>, mode: "child" | "headless", timeoutMs: number) =>
  Effect.callback<{ info: CoreInfo; stop: () => Promise<void> }, CoreStartError>((resume) => {
    const [bin, ...args] = command
    const proc = spawn(bin!, [...args, "--root", root, "--mode", mode], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: mode === "headless",
    })
    let out = ""
    let err = ""
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.kill("SIGTERM")
      resume(Effect.fail(new CoreStartError({ message })))
    }
    const timer = setTimeout(() => fail(`core did not start within ${timeoutMs}ms${err ? `:\n${err}` : ""}`), timeoutMs)
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()))
    proc.on("error", (e) => fail(`core could not start: ${e.message}`))
    proc.on("exit", (code) => fail(`core exited with code ${code}${err ? `:\n${err.trim()}` : ""}`))
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString()
      if (settled || !out.includes("\n")) return
      const info = readInfo(root)
      if (!out.startsWith("ready ") || info === undefined || info.pid !== proc.pid) return fail(`core did not report ready: ${out.trim()}`)
      settled = true
      clearTimeout(timer)
      if (mode === "headless") {
        proc.stdin.end()
        proc.stdout.destroy()
        proc.stderr.destroy()
        proc.unref()
      }
      const exited = new Promise<void>((r) => proc.once("exit", () => r()))
      resume(
        Effect.succeed({
          info,
          stop: async () => {
            proc.stdin.end()
            proc.kill("SIGTERM")
            await exited
          },
        }),
      )
    })
  })

/**
 * Attach to this project's running core, or start one as a child of this process.
 * `command` runs zarg-core (for example `[process.execPath, "<path>/main.ts"]`).
 */
export const connect = (opts: { readonly root: string; readonly command: ReadonlyArray<string>; readonly timeoutMs?: number }) =>
  Effect.gen(function* () {
    const live = readInfo(opts.root)
    if (live !== undefined) return { info: live, owned: false, close: async () => {} } satisfies Connection
    const child = yield* start(opts.root, opts.command, "child", opts.timeoutMs ?? 30_000)
    return { info: child.info, owned: true, close: child.stop } satisfies Connection
  })

/** Start a headless core that outlives this process. Fails when a core is already running. */
export const startHeadless = (opts: { readonly root: string; readonly command: ReadonlyArray<string>; readonly timeoutMs?: number }) =>
  Effect.gen(function* () {
    const live = readInfo(opts.root)
    if (live !== undefined) return yield* new CoreStartError({ message: `a core is already running for this project (pid ${live.pid})` })
    return (yield* start(opts.root, opts.command, "headless", opts.timeoutMs ?? 30_000)).info
  })

/** Stop this project's core, whichever process started it. Resolves once it is gone. */
export const stopCore = (root: string, timeoutMs = 10_000) =>
  Effect.gen(function* () {
    const info = readInfo(root)
    if (info === undefined) return false
    process.kill(info.pid, "SIGTERM")
    const deadline = Date.now() + timeoutMs
    while (isAlive(info.pid)) {
      if (Date.now() > deadline) return yield* new CoreStartError({ message: `core (pid ${info.pid}) did not stop within ${timeoutMs}ms` })
      yield* Effect.sleep(50)
    }
    return true
  })
```

`packages/client/src/index.ts` (Task 3 adds `./state`):

```ts
export * from "./client"
export * from "./connect"
export * from "./events"
export * from "./info"
export * from "./sse"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/client && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (9 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
mise run verify
git add packages/client bun.lock
git commit -m "feat(client): core.json, attach or spawn a core, SSE client"
```

---

### Task 3: Thread state reducer

**Files:**
- Create: `packages/client/src/state.ts`
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/test/state.test.ts`

**Interfaces:**
- Consumes: `WireEvent`, `Option` (Task 2).
- Produces: `ThreadState { threadId, messages: Message[], pendingInquiry?: Inquiry, rlms: Record<string, RlmNode>, status: "idle" | "running" | "waiting" | "error", error?: { code?, message }, seq }`; `Message { id, role, text }`; `Inquiry { id, question, options, allowOther, about }`; `RlmNode { id, parent, preset, depth, turns, budget, tokens?, status, decisions: Decision[], error? }`; `Decision { kind: "atomize", atomic, criteria }`; `initial(threadId)`; `reduce(state, event)`.

- [ ] **Step 1: Write the failing test**

`packages/client/test/state.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { initial, reduce, type ThreadState, type WireEvent } from "../src"

let seq = 0
const ev = (type: string, fields: Record<string, unknown> = {}, threadId = "main"): WireEvent => ({ type, threadId, seq: ++seq, ...fields })
const fold = (events: ReadonlyArray<WireEvent>, s: ThreadState = initial("main")) => events.reduce(reduce, s)
const text = (id: string, role: string, delta: string) => [
  ev("TEXT_MESSAGE_START", { messageId: id, role }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: id, delta }),
  ev("TEXT_MESSAGE_END", { messageId: id }),
]
const inquiry = {
  id: "inq-1",
  reason: "inquiry",
  message: "Which card first?",
  metadata: { options: [{ id: "a", label: "Checkout", recommended: true, why: "most used" }, { id: "b", label: "Login" }], allowOther: true, about: ["UX-0001"] },
}

describe("reduce", () => {
  test("a run that ends in an inquiry: running, then waiting with the inquiry", () => {
    const running = fold([ev("RUN_STARTED", { runId: "r1" })])
    expect(running.status).toBe("running")
    const s = fold([ev("RUN_FINISHED", { runId: "r1", outcome: { type: "interrupt", interrupts: [inquiry] } })], running)
    expect(s.status).toBe("waiting")
    expect(s.pendingInquiry).toEqual({ id: "inq-1", question: "Which card first?", options: inquiry.metadata.options, allowOther: true, about: ["UX-0001"] })
  })

  test("messages build from START, CONTENT, END; the next run clears the inquiry once it finishes", () => {
    const s = fold([
      ev("RUN_STARTED", { runId: "r1" }),
      ev("RUN_FINISHED", { runId: "r1", outcome: { type: "interrupt", interrupts: [inquiry] } }),
      ev("RUN_STARTED", { runId: "r2" }),
      ...text("u1", "user", "Checkout"),
      ...text("a1", "assistant", "Working on checkout."),
      ev("RUN_FINISHED", { runId: "r2" }),
    ])
    expect(s.messages).toEqual([
      { id: "u1", role: "user", text: "Checkout" },
      { id: "a1", role: "assistant", text: "Working on checkout." },
    ])
    expect(s.pendingInquiry).toBeUndefined()
    expect(s.status).toBe("idle")
  })

  test("RUN_ERROR shows the error; the next run clears it", () => {
    const failed = fold([ev("RUN_STARTED"), ev("RUN_ERROR", { message: "model unreachable", code: "model" })])
    expect(failed).toMatchObject({ status: "error", error: { code: "model", message: "model unreachable" } })
    const again = fold([ev("RUN_STARTED")], failed)
    expect(again.status).toBe("running")
    expect(again.error).toBeUndefined()
  })

  test("the RLM tree follows the activity snapshot and deltas", () => {
    const node = (id: string, parent: string | null, status = "running") => ({ id, parent, preset: "driver", depth: 0, turns: 1, budget: 20, status, decisions: [] })
    const s = fold([
      ev("ACTIVITY_SNAPSHOT", { messageId: "m", activityType: "zarg.rlm", content: { rlms: { "rlm-1": node("rlm-1", null) } } }),
      ev("ACTIVITY_DELTA", { messageId: "m", activityType: "zarg.rlm", patch: [{ op: "add", path: "/rlms/rlm-2", value: node("rlm-2", "rlm-1") }] }),
      ev("ACTIVITY_DELTA", { messageId: "m", activityType: "zarg.rlm", patch: [{ op: "replace", path: "/rlms/rlm-1", value: node("rlm-1", null, "done") }] }),
    ])
    expect(Object.keys(s.rlms)).toEqual(["rlm-1", "rlm-2"])
    expect(s.rlms["rlm-1"]!.status).toBe("done")
    expect(s.rlms["rlm-2"]!.parent).toBe("rlm-1")
  })

  test("a stopped run (cancelled) is idle; other threads' events and replayed events are ignored", () => {
    const s = fold([ev("RUN_STARTED"), ev("RUN_FINISHED", { outcome: { type: "cancelled" } })])
    expect(s.status).toBe("idle")
    const other = reduce(s, ev("RUN_STARTED", {}, "checkout"))
    expect(other.status).toBe("idle")
    const replay = reduce(s, { type: "RUN_STARTED", threadId: "main", seq: 1 })
    expect(replay).toBe(s)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/client && mise x -- bun test test/state.test.ts`
Expected: FAIL (`initial` and `reduce` are not exported).

- [ ] **Step 3: Implement**

`packages/client/src/state.ts`:

```ts
import type { Option, WireEvent } from "./events"

export interface Message {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface Inquiry {
  readonly id: string
  readonly question: string
  readonly options: ReadonlyArray<Option>
  readonly allowOther: boolean
  readonly about: ReadonlyArray<string>
}

export interface Decision {
  readonly kind: "atomize"
  readonly atomic: boolean
  readonly criteria: ReadonlyArray<{ readonly name: string; readonly answer: boolean; readonly confidence: number }>
}

export interface RlmNode {
  readonly id: string
  readonly parent: string | null
  readonly preset: string
  readonly depth: number
  readonly turns: number
  readonly budget: number
  readonly tokens?: number
  readonly status: "running" | "done" | "failed" | "stopped"
  readonly decisions: ReadonlyArray<Decision>
  readonly error?: string
}

export interface ThreadState {
  readonly threadId: string
  readonly messages: ReadonlyArray<Message>
  readonly pendingInquiry?: Inquiry
  readonly rlms: Readonly<Record<string, RlmNode>>
  readonly status: "idle" | "running" | "waiting" | "error"
  readonly error?: { readonly code?: string; readonly message: string }
  /** The last event applied; events at or before it are ignored (replays after a reconnect). */
  readonly seq: number
}

export const initial = (threadId: string): ThreadState => ({ threadId, messages: [], rlms: {}, status: "idle", seq: 0 })

type Patch = { readonly op: string; readonly path: string; readonly value?: unknown }

/** Apply the JSON Patch operations core sends for the RLM tree (add, replace, remove under /rlms). */
const patchRlms = (rlms: ThreadState["rlms"], patch: ReadonlyArray<Patch>) => {
  const next: Record<string, RlmNode> = { ...rlms }
  for (const p of patch) {
    const m = /^\/rlms\/([^/]+)$/.exec(p.path)
    if (m === null) continue
    const id = m[1]!.replace(/~1/g, "/").replace(/~0/g, "~")
    if (p.op === "remove") delete next[id]
    else if (p.op === "add" || p.op === "replace") next[id] = p.value as RlmNode
  }
  return next
}

/** Fold one core event into a thread's state. Events of other threads are ignored. */
export const reduce = (s: ThreadState, e: WireEvent): ThreadState => {
  if (e.threadId !== s.threadId || e.seq <= s.seq) return s
  const t: ThreadState = { ...s, seq: e.seq }
  switch (e.type) {
    case "RUN_STARTED": {
      const { error: _, ...rest } = t
      return { ...rest, status: "running" }
    }
    case "RUN_FINISHED": {
      const outcome = e.outcome as { type: string; interrupts?: ReadonlyArray<Record<string, any>> } | undefined
      const i = outcome?.type === "interrupt" ? outcome.interrupts?.[0] : undefined
      const { pendingInquiry: _, ...rest } = t
      if (i === undefined) return { ...rest, status: "idle" }
      const meta = (i.metadata ?? {}) as { options?: ReadonlyArray<Option>; allowOther?: boolean; about?: ReadonlyArray<string> }
      return {
        ...rest,
        status: "waiting",
        pendingInquiry: { id: String(i.id), question: String(i.message ?? ""), options: meta.options ?? [], allowOther: meta.allowOther ?? true, about: meta.about ?? [] },
      }
    }
    case "RUN_ERROR":
      return { ...t, status: "error", error: { message: String(e.message), ...(e.code !== undefined ? { code: String(e.code) } : {}) } }
    case "TEXT_MESSAGE_START":
      return { ...t, messages: [...t.messages, { id: String(e.messageId), role: e.role === "user" ? "user" : "assistant", text: "" }] }
    case "TEXT_MESSAGE_CONTENT":
      return { ...t, messages: t.messages.map((m) => (m.id === e.messageId ? { ...m, text: m.text + String(e.delta) } : m)) }
    case "ACTIVITY_SNAPSHOT":
      return { ...t, rlms: ((e.content as { rlms?: ThreadState["rlms"] } | undefined)?.rlms ?? {}) }
    case "ACTIVITY_DELTA":
      return { ...t, rlms: patchRlms(t.rlms, (e.patch as ReadonlyArray<Patch>) ?? []) }
    default:
      return t
  }
}
```

Append to `packages/client/src/index.ts`:

```ts
export * from "./state"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/client && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/client
git commit -m "feat(client): reduce AG-UI events to thread state"
```

---

### Task 4: Core events, log and threads' driver loop

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/mise.toml`
- Create: `packages/core/src/events.ts`, `src/log.ts`, `src/thread.ts`, `src/index.ts`
- Test: `packages/core/test/thread.test.ts`

**Interfaces:**
- Consumes: `Rlm.RlmEvent`, `RlmDeps.observe`, `Answer.interjected` (Task 1); `Asker`, `Question`, `Answer` from `@zarg/rlm`; `AgendaItem` from `@zarg/plugin/server`.
- Produces:
  - `events.ts`: `WireEvent`, `Draft`, builders `runStarted`, `runFinished`, `runInterrupted(threadId, runId, interrupt)`, `runStopped` (outcome `cancelled`), `runError(message, code)`, `textMessage(messageId, role, text)` (START/CONTENT/END), `ACTIVITY_TYPE = "zarg.rlm"`, `activitySnapshot`, `activityDelta`.
  - `log.ts`: `makeLog(dir, redact)` → `ThreadLog { append(threadId, draft): Effect<WireEvent>, stream(since, threadId?): Stream<WireEvent>, all(), exists(threadId) }`.
  - `thread.ts`: `WHAT_NEXT`; `RunInput { runId, message?, resume? }`; `ThreadDeps { id, focus, log, agenda(focus), driver(spec, asker, observe) }`; `makeThread(deps)` → `Thread { id, focus, run(RunInput): Stream<WireEvent>, stop: Effect<void>, status(): "waiting" | "running" | "idle" }`.
  - Interrupt shape: `{ id: "inq-N", reason: "inquiry", message: question, metadata: { options, allowOther, about }, responseSchema }`. RLM tree node: `{ id, parent, preset, scope, depth, turns, budget, tokens?, status, decisions: [{ kind: "atomize", atomic, criteria }], plan?, error? }` at `/rlms/<id>`.

- [ ] **Step 1: Create the package**

`packages/core/package.json`:

```json
{
  "name": "@zarg/core",
  "dependencies": {
    "@ag-ui/core": "1.0.0",
    "@effect/platform-bun": "^4.0.0-rc.117",
    "@zarg/client": "workspace:*",
    "@zarg/decisions": "workspace:*",
    "@zarg/graph": "workspace:*",
    "@zarg/kernel": "workspace:*",
    "@zarg/model": "workspace:*",
    "@zarg/plugin": "workspace:*",
    "@zarg/plugin-gherkin": "workspace:*",
    "@zarg/provider-openrouter": "workspace:*",
    "@zarg/provider-zarg-router": "workspace:*",
    "@zarg/rlm": "workspace:*",
    "effect": "^4.0.0-rc.117",
    "zod": "3"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "private": true,
  "type": "module"
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/core/mise.toml`:

```toml
[tasks.typecheck]
run = "mise x -- bunx tsc"

[tasks.test]
run = "mise x -- bun test"
```

Run: `mise x -- bun install`
Expected: `@ag-ui/core` 1.0.0 and `zod` 3 installed; `bun.lock` changes.

- [ ] **Step 2: Write the failing test**

`packages/core/test/thread.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import type { Asker, Rlm } from "@zarg/rlm"
import { makeLog } from "../src/log"
import { makeThread, WHAT_NEXT } from "../src/thread"
import type { WireEvent } from "../src/events"

type Driver = (spec: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.RlmOutcome, Rlm.RlmError>

const outcome = (value: unknown): Rlm.RlmOutcome => ({ id: "rlm-x", value, turns: 1, tokens: 1 })

/** A thread over a fresh log with a scripted driver; `agenda` answers with the given items each time. */
const setup = (driver: Driver, agenda: () => ReadonlyArray<AgendaItem> = () => []) =>
  Effect.gen(function* () {
    const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-thread-")), (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))
    const thread = yield* makeThread({ id: "main", focus: [], log, agenda: () => Effect.succeed(agenda()), driver })
    return { log, thread }
  })

const collect = (s: Stream.Stream<WireEvent>) => Effect.map(Stream.runCollect(s), (c) => [...c])
const last = (events: ReadonlyArray<WireEvent>) => events.at(-1)!
const texts = (events: ReadonlyArray<WireEvent>) => events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
const question = { question: "Which?", options: [{ id: "a", label: "Option A", recommended: true, why: "simpler" }, { id: "b", label: "Option B" }] }

describe("thread runs", () => {
  test("a run ends with an interrupt when the driver asks; resume continues the same driver", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ > 0) return yield* Effect.never
        const a = yield* asker.ask(question)
        return outcome(`picked ${a.choice}`)
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* collect(thread.run({ runId: "r1" }))
        const interrupt = last(first) as any
        const second = yield* collect(
          thread.run({ runId: "r2", resume: [{ interruptId: interrupt.outcome.interrupts[0].id, payload: { choice: "a" } }] }).pipe(Stream.take(8)),
        )
        return { first, interrupt, second }
      }),
    )
    expect(String(out.first[0]?.type)).toBe("RUN_STARTED")
    expect(out.interrupt).toMatchObject({ type: "RUN_FINISHED", runId: "r1", outcome: { type: "interrupt", interrupts: [{ reason: "inquiry", message: "Which?" }] } })
    expect(out.interrupt.outcome.interrupts[0].metadata.options[0]).toMatchObject({ id: "a", recommended: true })
    expect(texts(out.second)).toEqual(["Option A", "picked a"])
    expect(tasks[0]).toBe(WHAT_NEXT)
  })

  test("a message while a question is pending answers it as an interjection", async () => {
    const answers: Array<unknown> = []
    let calls = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ > 0) return yield* Effect.never
        answers.push(yield* asker.ask(question))
        return outcome("adapted")
      }) as never
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        yield* collect(thread.run({ runId: "r1" }))
        return yield* collect(thread.run({ runId: "r2", message: "actually, do payments first" }).pipe(Stream.take(11)))
      }),
    )
    expect(answers).toEqual([{ other: "actually, do payments first", interjected: true }])
    expect(texts(second)).toEqual(["actually, do payments first", "(dropped question: Which?)", "adapted"])
  })

  test("a new run while the driver works ends the open run; the message reaches the next driver", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (calls++ === 0) {
          yield* Effect.sleep(100)
          return outcome("first item done")
        }
        return yield* Effect.map(asker.ask(question), () => outcome("unused"))
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(20)
        const second = yield* collect(thread.run({ runId: "r2", message: "also add a logout card" }))
        return { first: yield* Fiber.join(first), second }
      }),
    )
    expect(last(out.first)).toMatchObject({ type: "RUN_FINISHED", runId: "r1" })
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
    expect(tasks[1]).toContain("developer: also add a logout card")
  })

  test("the agenda's first item is the driver's task, with recent conversation", async () => {
    const tasks: Array<string> = []
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        return (yield* asker.ask(question)) as never
      }) as never
    const item: AgendaItem = { id: "gherkin:dead-end:S-0004", title: "What happens after payment?", detail: "No card continues from S-0004.", about: ["S-0004"], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        yield* collect(thread.run({ runId: "r1", message: "hello" }))
      }),
    )
    expect(tasks[0]).toContain("What happens after payment?\nNo card continues from S-0004.")
    expect(tasks[0]).toContain("Recent conversation:\ndeveloper: hello")
  })

  test("an item still open after two passes turns into a what-next question", async () => {
    const tasks: Array<string> = []
    let calls = 0
    const driver: Driver = (spec, asker) =>
      Effect.gen(function* () {
        tasks.push(spec.task)
        if (++calls < 3) return outcome(`pass ${calls}`)
        return (yield* asker.ask(question)) as never
      }) as never
    const item: AgendaItem = { id: "x", title: "Stuck item", detail: "d", about: [], priority: 2 }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver, () => [item])
        yield* collect(thread.run({ runId: "r1" }))
      }),
    )
    expect(tasks[0]).toContain("Stuck item")
    expect(tasks[1]).toContain("Stuck item")
    expect(tasks[2]).toContain(WHAT_NEXT)
    expect(tasks[2]).toContain('"Stuck item" is still open after two passes')
  })

  test("a failing driver ends the run with RUN_ERROR; the next run tries again", async () => {
    let calls = 0
    const driver: Driver = (_spec, asker) =>
      Effect.gen(function* () {
        if (calls++ === 0) return yield* Effect.fail({ _tag: "RlmError", kind: "model", message: "router down" } as never)
        return (yield* asker.ask(question)) as never
      }) as never
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread } = yield* setup(driver)
        const first = yield* collect(thread.run({ runId: "r1" }))
        const second = yield* collect(thread.run({ runId: "r2" }))
        return { first, second }
      }),
    )
    expect(last(out.first)).toMatchObject({ type: "RUN_ERROR", message: "router down", code: "model" })
    expect(last(out.second)).toMatchObject({ type: "RUN_FINISHED", runId: "r2", outcome: { type: "interrupt" } })
  })

  test("stop interrupts the running driver and records it", async () => {
    let interrupted = false
    const driver: Driver = () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))) as never
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const { thread, log } = yield* setup(driver)
        yield* Effect.forkChild(collect(thread.run({ runId: "r1" })))
        yield* Effect.sleep(50)
        yield* thread.stop
        return log.all()
      }),
    )
    expect(interrupted).toBe(true)
    expect(texts(events as WireEvent[])).toContain("(stopped)")
    expect(last(events as WireEvent[])).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "cancelled" } })
  })

  test("RLM activity becomes activity deltas for the agents pane", async () => {
    const driver: Driver = (_spec, asker, observe) =>
      Effect.gen(function* () {
        observe({ type: "start", id: "rlm-1", parent: undefined, preset: "driver", scope: {}, depth: 0, budget: { turns: 25, tokens: 1, wallMs: 1 } })
        observe({ type: "turn", id: "rlm-1", turn: 1, tokens: 10 })
        return (yield* asker.ask(question)) as never
      }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    const deltas = events.filter((e) => e.type === "ACTIVITY_DELTA") as any[]
    expect(deltas.at(-1).patch[0]).toMatchObject({ op: "add", path: "/rlms/rlm-1", value: { preset: "driver", turns: 1, budget: 25, status: "running" } })
    expect(events.some((e) => e.type === "ACTIVITY_SNAPSHOT")).toBe(true)
  })

  test("secrets are redacted before events are stored or sent", async () => {
    const driver: Driver = (_spec, asker) => Effect.gen(function* () { return (yield* asker.ask({ ...question, question: "use zt-secret?" })) as never }) as never
    const events = await Effect.runPromise(Effect.gen(function* () { const { thread } = yield* setup(driver); return yield* collect(thread.run({ runId: "r1" })) }))
    expect(JSON.stringify(events)).not.toContain("zt-secret")
    expect(JSON.stringify(events)).toContain("<redacted:ZT>")
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/core && mise x -- bun test test/thread.test.ts`
Expected: FAIL (`../src/log` does not exist).

- [ ] **Step 4: Implement**

`packages/core/src/events.ts`:

```ts
import { type BaseEvent, EventType, type Interrupt } from "@ag-ui/core"

/** An AG-UI event as core sends it: the event plus the thread it belongs to and its sequence number. */
export type WireEvent = BaseEvent & { readonly threadId: string; readonly seq: number; readonly [key: string]: unknown }

type Draft = { readonly type: EventType; readonly [key: string]: unknown }

export const runStarted = (threadId: string, runId: string): Draft => ({ type: EventType.RUN_STARTED, threadId, runId })

export const runFinished = (threadId: string, runId: string): Draft => ({ type: EventType.RUN_FINISHED, threadId, runId })

export const runInterrupted = (threadId: string, runId: string, interrupt: Interrupt): Draft => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  outcome: { type: "interrupt", interrupts: [interrupt] },
})

export const runStopped = (threadId: string, runId: string): Draft => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  outcome: { type: "cancelled" },
})

export const runError = (message: string, code: string): Draft => ({ type: EventType.RUN_ERROR, message, code })

/** A whole text message as START, CONTENT, END. */
export const textMessage = (messageId: string, role: "assistant" | "user", text: string): ReadonlyArray<Draft> => [
  { type: EventType.TEXT_MESSAGE_START, messageId, role },
  ...(text.length > 0 ? [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text }] : []),
  { type: EventType.TEXT_MESSAGE_END, messageId },
]

export const ACTIVITY_TYPE = "zarg.rlm"

export const activitySnapshot = (messageId: string, content: Record<string, unknown>): Draft => ({
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId,
  activityType: ACTIVITY_TYPE,
  content,
})

export const activityDelta = (messageId: string, patch: ReadonlyArray<Record<string, unknown>>): Draft => ({
  type: EventType.ACTIVITY_DELTA,
  messageId,
  activityType: ACTIVITY_TYPE,
  patch,
})

export type { Draft }
```

`packages/core/src/log.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, PubSub, Stream } from "effect"
import type { Draft, WireEvent } from "./events"

/**
 * Every event of every thread, in order: kept in memory for `/stream?since=`, appended to
 * `<dir>/<threadId>.jsonl`, and published to live subscribers. `redact` runs before anything is stored or sent.
 */
export const makeLog = (dir: string, redact: (text: string) => string) =>
  Effect.gen(function* () {
    mkdirSync(dir, { recursive: true })
    const events: Array<WireEvent> = []
    // Earlier sessions' events come first so sequence numbers keep increasing across restarts.
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (line.trim().length > 0) events.push(JSON.parse(line) as WireEvent)
      }
    }
    events.sort((a, b) => a.seq - b.seq)
    let seq = events.at(-1)?.seq ?? 0
    const hub = yield* PubSub.unbounded<WireEvent>()

    const append = (threadId: string, draft: Draft): Effect.Effect<WireEvent> =>
      Effect.gen(function* () {
        const event = JSON.parse(redact(JSON.stringify({ ...draft, threadId, seq: ++seq }))) as WireEvent
        events.push(event)
        appendFileSync(join(dir, `${threadId}.jsonl`), `${JSON.stringify(event)}\n`)
        yield* PubSub.publish(hub, event)
        return event
      })

    /** Events after `since`, then live events, optionally for one thread. */
    const stream = (since: number, threadId?: string): Stream.Stream<WireEvent> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(hub)
          const past = events.filter((e) => e.seq > since && (threadId === undefined || e.threadId === threadId))
          const last = past.at(-1)?.seq ?? since
          const live = Stream.fromSubscription(sub).pipe(Stream.filter((e: WireEvent) => e.seq > last && (threadId === undefined || e.threadId === threadId)))
          return Stream.concat(Stream.fromIterable(past), live)
        }),
      )

    return { append, stream, all: () => events as ReadonlyArray<WireEvent>, exists: (threadId: string) => existsSync(join(dir, `${threadId}.jsonl`)) }
  })

export type ThreadLog = Effect.Success<ReturnType<typeof makeLog>>
```

`packages/core/src/thread.ts`:

```ts
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import type { Answer, Asker, Question, Rlm, Scope } from "@zarg/rlm"
import * as E from "./events"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"

export const WHAT_NEXT =
  "The agenda is empty. Ask the developer what to work on next, with options drawn from the graph (unexplored branches, missing failure cases, the next journey)."

/** A resume or a typed message, as a run brings it in. */
export interface RunInput {
  readonly runId: string
  /** The newest user message, when the developer typed something. */
  readonly message?: string
  readonly resume?: ReadonlyArray<{ readonly interruptId: string; readonly payload?: unknown }>
}

export interface ThreadDeps {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly log: ThreadLog
  readonly agenda: (focus: ReadonlySet<string> | undefined) => Effect.Effect<ReadonlyArray<AgendaItem>, unknown>
  /** Runs one driver RLM; the thread supplies the Asker its Inquire service must use and an observer for activity. */
  readonly driver: (spec: Rlm.RlmSpec, asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.RlmOutcome, Rlm.RlmError>
}

interface Pending {
  readonly id: string
  readonly question: Question
  readonly answer: Deferred.Deferred<Answer>
}

let interruptCounter = 0

/** One driver thread: a loop of driver RLMs, one per agenda item, paused at inquiries. */
export const makeThread = (deps: ThreadDeps) =>
  Effect.gen(function* () {
    const { log, id: threadId } = deps
    let runId = ""
    /** True from RUN_STARTED until this run's RUN_FINISHED or RUN_ERROR. */
    let open = false
    let loop: Fiber.Fiber<void, never> | undefined
    let pending: Pending | undefined
    let paused: Deferred.Deferred<void> | undefined
    const recent: Array<string> = []
    const activity = new Map<string, Record<string, unknown>>()
    let messageCounter = 0
    const emit = (d: E.Draft) => {
      if (d.type === "RUN_FINISHED" || d.type === "RUN_ERROR") open = false
      return log.append(threadId, d)
    }
    const emitAll = (ds: ReadonlyArray<E.Draft>) => Effect.forEach(ds, emit, { discard: true })
    const note = (role: "assistant" | "user", text: string) => {
      recent.push(`${role === "user" ? "developer" : "driver"}: ${text}`)
      if (recent.length > 8) recent.shift()
      return emitAll(E.textMessage(`${threadId}-m${++messageCounter}`, role, text))
    }

    // Inquire: park the cell and end the current run with an interrupt; a later run's resume answers it.
    const asker: Asker = {
      ask: (question) =>
        Effect.gen(function* () {
          const answer = yield* Deferred.make<Answer>()
          const id = `inq-${++interruptCounter}`
          pending = { id, question, answer }
          yield* emit(
            E.runInterrupted(threadId, runId, {
              id,
              reason: "inquiry",
              message: question.question,
              metadata: { options: question.options, allowOther: question.allowOther ?? true, about: question.about ?? [] },
              responseSchema: {
                oneOf: [
                  { type: "object", properties: { choice: { enum: question.options.map((o) => o.id) } }, required: ["choice"] },
                  { type: "object", properties: { other: { type: "string" } }, required: ["other"] },
                ],
              },
            } as never),
          )
          return yield* Deferred.await(answer)
        }),
    }

    // RLM events become one activity message: the tree of RLMs working for this thread.
    const observe = (e: Rlm.RlmEvent) => {
      const prev = activity.get(e.id) ?? {}
      const next: Record<string, unknown> =
        e.type === "start"
          ? { id: e.id, parent: e.parent ?? null, preset: e.preset, scope: e.scope, depth: e.depth, turns: 0, budget: e.budget.turns, status: "running", decisions: [] }
          : e.type === "turn"
            ? { ...prev, turns: e.turn, tokens: e.tokens }
            : e.type === "atomize"
              ? { ...prev, decisions: [...((prev.decisions as Array<unknown>) ?? []), { kind: "atomize", atomic: e.atomic, criteria: e.criteria }] }
              : e.type === "plan"
                ? { ...prev, plan: e.children }
                : e.ok
                  ? { ...prev, status: "done", turns: e.turns, tokens: e.tokens }
                  : { ...prev, status: e.kind === "stopped" ? "stopped" : "failed", error: e.message }
      activity.set(e.id, next)
      Effect.runSync(emit(E.activityDelta(`${threadId}-activity`, [{ op: "add", path: `/rlms/${e.id}`, value: next }])))
    }

    const scope: Scope = deps.focus.length > 0 ? { graph: { focus: deps.focus, k: 2 } } : {}
    const focusSet = deps.focus.length > 0 ? new Set(deps.focus) : undefined

    const body = Effect.gen(function* () {
      let lastItem = ""
      let passes = 0
      while (true) {
        const items = yield* deps.agenda(focusSet).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgendaItem>))
        const item = items[0]
        passes = item !== undefined && item.id === lastItem ? passes + 1 : 1
        lastItem = item?.id ?? ""
        // The same item still open after two passes: ask what next instead of looping on it.
        const stuck = item !== undefined && passes > 2
        const task = [
          item === undefined || stuck ? WHAT_NEXT : `${item.title}\n${item.detail}`,
          stuck ? `Note: "${item!.title}" is still open after two passes; mention it among the options.` : "",
          recent.length > 0 ? `Recent conversation:\n${recent.join("\n")}` : "",
        ]
          .filter((x) => x.length > 0)
          .join("\n\n")
        const outcome = yield* Effect.exit(deps.driver({ task, preset: "driver", scope }, asker, observe))
        if (Exit.isSuccess(outcome)) {
          yield* note("assistant", String(outcome.value.value))
          continue
        }
        const err = outcome.cause.reasons.find((r) => r._tag === "Fail")?.error
        // Set up the pause before announcing the error: the next run may arrive as soon as it is sent.
        const wait = yield* Deferred.make<void>()
        paused = wait
        yield* emit(E.runError(err?.message ?? "the driver failed", err?.kind ?? "error"))
        yield* Deferred.await(wait)
      }
    })

    const startLoop = Effect.gen(function* () {
      if (loop === undefined) loop = yield* Effect.forkDetach(body as Effect.Effect<void>)
    })

    const run = (input: RunInput): Stream.Stream<WireEvent> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const from = log.all().at(-1)?.seq ?? 0
          // A run still open (the driver was working, no question yet) ends here; this run takes over.
          if (open) yield* emit(E.runFinished(threadId, runId))
          runId = input.runId
          open = true
          yield* emit(E.runStarted(threadId, runId))
          yield* emit(E.activitySnapshot(`${threadId}-activity`, { rlms: Object.fromEntries(activity) }))
          const resume = input.resume?.[0]
          if (resume !== undefined && pending !== undefined && resume.interruptId === pending.id) {
            const payload = (resume.payload ?? {}) as { choice?: string; other?: string }
            const chosen = pending.question.options.find((o) => o.id === payload.choice)
            const answer: Answer = payload.choice !== undefined ? { choice: payload.choice } : { other: String(payload.other ?? "") }
            const p = pending
            pending = undefined
            yield* note("user", chosen?.label ?? String(payload.other ?? ""))
            yield* Deferred.succeed(p.answer, answer)
          } else if (input.message !== undefined && pending !== undefined) {
            // Interjection: the message answers the pending question; the question is recorded as dropped.
            const p = pending
            pending = undefined
            yield* note("user", input.message)
            yield* note("assistant", `(dropped question: ${p.question.question})`)
            yield* Deferred.succeed(p.answer, { other: input.message, interjected: true } as Answer)
          } else {
            // A resume for an interrupt this core does not know (e.g. after a restart) counts as a message.
            const text = input.message ?? (resume !== undefined ? String((resume.payload as { other?: string; choice?: string })?.other ?? (resume.payload as { choice?: string })?.choice ?? "") : undefined)
            if (text !== undefined && text.length > 0) yield* note("user", text)
          }
          if (paused !== undefined) {
            const p = paused
            paused = undefined
            yield* Deferred.succeed(p, undefined)
          }
          yield* startLoop
          const mine = runId
          return log.stream(from, threadId).pipe(
            Stream.takeUntil((e) => (e.type === "RUN_FINISHED" && e.runId === mine) || e.type === "RUN_ERROR"),
          )
        }),
      )

    /** Stop the thread's current work: the running RLM and its children are interrupted. */
    const stop = Effect.gen(function* () {
      const f = loop
      loop = undefined
      pending = undefined
      paused = undefined
      if (f !== undefined) yield* Fiber.interrupt(f)
      yield* note("assistant", "(stopped)")
      yield* emit(E.runStopped(threadId, runId))
    })

    return { id: threadId, focus: deps.focus, run, stop, status: () => (pending ? "waiting" : loop ? "running" : "idle") }
  })

export type Thread = Effect.Success<ReturnType<typeof makeThread>>
```

`packages/core/src/index.ts` (Tasks 5 and 6 add lines):

```ts
export * from "./events"
export * from "./log"
export * from "./thread"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
mise run verify
git add packages/core bun.lock
git commit -m "feat(core): thread log and driver loop with inquiries as AG-UI interrupts"
```

---

### Task 5: HTTP API and thread registry

**Files:**
- Create: `packages/core/src/server.ts`, `packages/core/src/threads.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/server.test.ts`

**Interfaces:**
- Consumes: `makeThread`, `Thread`, `ThreadLog`, `WireEvent` (Task 4); `Rlm.make`, `settings`, `inquire` from `@zarg/rlm`.
- Produces: services `Threads` (`{ get(id, focus): Effect<Thread>, list(): Thread[] }`), `Log` (`ThreadLog`) and `Token` (`string`); `makeThreads({ log, agenda, makeRlm(asker, observe): Effect<Rlm> })` returning `Threads["Service"]` (creates `main`); `api`, a router layer (`HttpRouter.addAll` routes plus a global auth middleware) needing `Threads`, `Log`, `Token`, serving `POST /runs` (AG-UI `RunAgentInput`, focus from `forwardedProps.focus`, SSE `data: <json>\n\n`), `GET /stream?since=`, `GET /threads`, `POST /threads/:id/stop`; 401 without the token, 400 for an invalid input, 404 for an unknown thread. Tests serve it with `HttpRouter.toWebHandler`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/server.test.ts` (`api` through `HttpRouter.toWebHandler`, over a real `Rlm` on a stub model; every event is checked against `@ag-ui/core`'s zod schemas):

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { EventSchemas } from "@ag-ui/core/schemas"
import { Model, type ChatMessage, type StreamEvent } from "@zarg/model"
import { type Asker, inquire, Rlm, settings } from "@zarg/rlm"
import { HttpRouter } from "effect/unstable/http"
import { api, Log, makeLog, makeThreads, Threads, Token } from "../src"

/** A stub model: the driver asks one question, then finishes with the answer. */
const stub = Layer.succeed(Model.Model, {
  client: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  info: () => Effect.die("unused"),
  warm: () => Effect.void,
  stream: (req) => {
    const toolResults = req.messages.filter((m: ChatMessage) => m.role === "tool").length
    const code =
      toolResults === 0
        ? 'const a = yield* Inquire.ask({ question: "Which card first?", options: [{ id: "a", label: "Checkout", recommended: true, why: "most used" }, { id: "b", label: "Login" }] })\nreturn a'
        : 'yield* Rlm.done({ value: "Working on the checkout card." })'
    const events: ReadonlyArray<StreamEvent> = [
      { type: "toolCall", call: { id: `c${toolResults}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
      { type: "done", finishReason: "tool_calls" },
    ]
    return Stream.fromIterable(events)
  },
})

const TOKEN = "t0ken"
/** The router as a fetch handler, over a real Rlm on the stub model (disposed after each test). */
const handlers: Array<{ dispose: () => Promise<void> }> = []
afterEach(() => Promise.all(handlers.splice(0).map((h) => h.dispose())))
const handler = async () => {
  const { threads, log } = await Effect.runPromise(
    Effect.gen(function* () {
      const log = yield* makeLog(mkdtempSync(join(tmpdir(), "zarg-srv-")), (t) => t)
      const model = yield* Model.Model
      const s = yield* settings({ presets: { driver: { layer: ["Inquire", "Rlm"], role: "driver", result: "text", verify: "none" } } })
      const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) =>
        Rlm.make({ settings: s, services: (n) => (n === "Inquire" ? inquire(asker) : undefined), roles: { driver: "stub:m" }, observe }).pipe(Effect.provideService(Model.Model, model))
      const threads = yield* makeThreads({ log, agenda: () => Effect.succeed([]), makeRlm })
      return { threads, log }
    }).pipe(Effect.provide(stub)),
  )
  const web = HttpRouter.toWebHandler(
    api.pipe(Layer.provide([Layer.succeed(Threads, threads), Layer.succeed(Log, log), Layer.succeed(Token, TOKEN)])),
    { disableLogger: true },
  )
  handlers.push(web)
  return (req: Request) => web.handler(req)
}

const post = (h: (r: Request) => Promise<Response>, path: string, body: unknown, token = TOKEN) =>
  h(new Request(`http://core${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }))

/** Read an SSE response into events, stopping at `limit` events (live streams never end on their own). */
const events = async (res: Response, limit = Infinity) => {
  const out: Array<any> = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (out.length < limit) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n\n")) !== -1 && out.length < limit) {
      out.push(JSON.parse(buf.slice(6, i)))
      buf = buf.slice(i + 2)
    }
  }
  await reader.cancel().catch(() => {})
  return out
}

const input = (runId: string, extra: Record<string, unknown> = {}) => ({ threadId: "main", runId, state: {}, messages: [], tools: [], context: [], forwardedProps: {}, ...extra })

describe("core HTTP API", () => {
  test("requests without the token are refused", async () => {
    const h = await handler()
    expect((await post(h, "/runs", input("r1"), "wrong")).status).toBe(401)
  })

  test("an invalid RunAgentInput is a 400", async () => {
    const h = await handler()
    expect((await post(h, "/runs", { threadId: "main" })).status).toBe(400)
  })

  test("a run streams AG-UI events and ends with the driver's inquiry as an interrupt; resume continues", async () => {
    const h = await handler()
    const first = await events(await post(h, "/runs", input("r1")))
    const finished = first.at(-1)
    expect(finished).toMatchObject({ type: "RUN_FINISHED", runId: "r1", outcome: { type: "interrupt" } })
    const interrupt = finished.outcome.interrupts[0]
    expect(interrupt).toMatchObject({ reason: "inquiry", message: "Which card first?", metadata: { options: [{ id: "a", recommended: true }, { id: "b" }] } })
    const second = await events(await post(h, "/runs", input("r2", { resume: [{ interruptId: interrupt.id, status: "resolved", payload: { choice: "a" } }] })), 12)
    const texts = second.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
    expect(texts).toEqual(["Checkout", "Working on the checkout card."])
  })

  test("a client that disconnects mid-run does not stop the thread; the next run gets the inquiry", async () => {
    const h = await handler()
    await events(await post(h, "/runs", input("r1")), 1)
    const again = await events(await post(h, "/runs", input("r2")))
    expect(again.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } })
  })

  test("every event is valid AG-UI 1.0", async () => {
    const h = await handler()
    const all = await events(await post(h, "/runs", input("r1")))
    for (const e of all) {
      const r = EventSchemas.safeParse(e)
      if (!r.success) throw new Error(`${e.type}: ${r.error.message}`)
    }
    expect(all.map((e) => e.type)).toContain("ACTIVITY_DELTA")
  })

  test("/stream replays events after a sequence number", async () => {
    const h = await handler()
    const run = await events(await post(h, "/runs", input("r1")))
    const since = run[1].seq
    const replay = await events(await h(new Request(`http://core/stream?since=${since}`, { headers: { authorization: `Bearer ${TOKEN}` } })), run.length - 2)
    expect(replay.map((e) => e.seq)).toEqual(run.slice(2).map((e) => e.seq))
  })

  test("/threads lists threads; stop stops the current work", async () => {
    const h = await handler()
    await events(await post(h, "/runs", input("r1")))
    const list = await (await h(new Request("http://core/threads", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()
    expect(list).toEqual([{ id: "main", focus: [], status: "waiting" }])
    const stopped = await post(h, "/threads/main/stop", {})
    expect(await stopped.json()).toEqual({ stopped: "main" })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core && mise x -- bun test test/server.test.ts`
Expected: FAIL (`api`, `Threads`, `Log`, `Token` and `makeThreads` are not exported).

- [ ] **Step 3: Implement**

`packages/core/src/threads.ts`:

```ts
import { Effect } from "effect"
import type { Asker, Rlm } from "@zarg/rlm"
import type { ThreadLog } from "./log"
import type { Threads } from "./server"
import { makeThread, type Thread, type ThreadDeps } from "./thread"

export interface ThreadsDeps {
  readonly log: ThreadLog
  readonly agenda: ThreadDeps["agenda"]
  /** An RLM runner whose Inquire uses `asker` and whose events go to `observe`. */
  readonly makeRlm: (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.Rlm>
}

/** Threads by id, created on first use. `main` exists from the start. */
export const makeThreads = (deps: ThreadsDeps) =>
  Effect.gen(function* () {
    const threads = new Map<string, Thread>()
    const create = (id: string, focus: ReadonlyArray<string>) =>
      makeThread({
        id,
        focus,
        log: deps.log,
        agenda: deps.agenda,
        driver: (spec, asker, observe) => Effect.flatMap(deps.makeRlm(asker, observe), (rlm) => rlm.exec(spec)),
      })
    threads.set("main", yield* create("main", []))
    const registry: Threads["Service"] = {
      get: (id, focus) =>
        Effect.gen(function* () {
          const existing = threads.get(id)
          if (existing !== undefined) return existing
          const t = yield* create(id, focus)
          threads.set(id, t)
          return t
        }),
      list: () => [...threads.values()],
    }
    return registry
  })
```

`packages/core/src/server.ts`:

```ts
import { Context, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RunAgentInputSchema } from "@ag-ui/core/schemas"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"
import type { Thread } from "./thread"

/** Driver threads by id. */
export class Threads extends Context.Service<
  Threads,
  {
    /** The thread with this id, created on first use with the given focus. */
    readonly get: (id: string, focus: ReadonlyArray<string>) => Effect.Effect<Thread>
    readonly list: () => ReadonlyArray<Thread>
  }
>()("@zarg/core/Threads") {}

/** The event log every thread writes to. */
export class Log extends Context.Service<Log, ThreadLog>()("@zarg/core/Log") {}

/** The bearer token every request must carry (from `.zarg/run/core.json`). */
export class Token extends Context.Service<Token, string>()("@zarg/core/Token") {}

const encoder = new TextEncoder()

/** An SSE response: each event as `data: <json>\n\n`. A client that disconnects interrupts only this stream. */
const sse = (events: Stream.Stream<WireEvent>) =>
  HttpServerResponse.stream(
    events.pipe(Stream.map((e) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`))),
    { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } },
  )

const error = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

/** Every route needs `Authorization: Bearer <token>`. */
const auth = HttpRouter.middleware(
  Effect.gen(function* () {
    const token = yield* Token
    return (app) =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        if (req.headers.authorization !== `Bearer ${token}`) return error(401, "unauthorized")
        return yield* app
      })
  }),
  { global: true },
)

const searchParam = (req: HttpServerRequest.HttpServerRequest, name: string) => new URL(req.url, "http://core").searchParams.get(name)

const routes = HttpRouter.addAll(
  Effect.gen(function* () {
    const threads = yield* Threads
    const log = yield* Log
    // Only a user message this core has not seen yet counts as new input.
    const seenMessages = new Set<string>()
    return [
      HttpRouter.route(
        "POST",
        "/runs",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest
          const body = yield* req.json.pipe(Effect.orElseSucceed(() => undefined))
          const parsed = RunAgentInputSchema.safeParse(body)
          if (!parsed.success) return error(400, `invalid RunAgentInput: ${parsed.error.message}`)
          const input = parsed.data
          const focusProp = (input.forwardedProps as { focus?: unknown } | undefined)?.focus
          const focus = Array.isArray(focusProp) ? focusProp.map(String) : []
          const lastMsg = input.messages.at(-1)
          const fresh = lastMsg !== undefined && lastMsg.role === "user" && !seenMessages.has(lastMsg.id)
          for (const m of input.messages) seenMessages.add(m.id)
          const message = fresh && typeof lastMsg.content === "string" ? lastMsg.content : undefined
          const resume = (input as { resume?: Array<{ interruptId: string; payload?: unknown }> }).resume
          const thread = yield* threads.get(input.threadId, focus)
          return sse(thread.run({ runId: input.runId, ...(message !== undefined ? { message } : {}), ...(resume ? { resume } : {}) }))
        }),
      ),
      HttpRouter.route(
        "GET",
        "/stream",
        Effect.map(HttpServerRequest.HttpServerRequest, (req) => sse(log.stream(Number(searchParam(req, "since") ?? 0)))),
      ),
      HttpRouter.route(
        "GET",
        "/threads",
        Effect.sync(() => HttpServerResponse.jsonUnsafe(threads.list().map((t) => ({ id: t.id, focus: t.focus, status: t.status() })))),
      ),
      HttpRouter.route(
        "POST",
        "/threads/:id/stop",
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.params
          const t = threads.list().find((x) => x.id === id)
          if (t === undefined) return error(404, "no such thread")
          yield* t.stop
          return HttpServerResponse.jsonUnsafe({ stopped: t.id })
        }),
      ),
    ]
  }),
)

/**
 * Core's HTTP API, as router layers. Needs `Threads`, `Log` and `Token`.
 *   POST /runs                 AG-UI RunAgentInput → SSE of the run's events
 *   GET  /stream?since=<seq>   every thread's events after seq, then live (SSE)
 *   GET  /threads              [{ id, focus, status }]
 *   POST /threads/:id/stop     stop the thread's current work
 */
export const api = Layer.mergeAll(routes, auth)
```

Append to `packages/core/src/index.ts`:

```ts
export * from "./server"
export * from "./threads"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/core
git commit -m "feat(core): AG-UI HTTP API on HttpRouter, SSE, token middleware"
```

---

### Task 6: The zarg-core process

**Files:**
- Create: `packages/core/src/lifecycle.ts`, `src/live.ts`, `src/main.ts`
- Modify: `packages/core/src/index.ts`, `.gitignore`, `AGENTS.md`
- Test: `packages/core/test/lifecycle.test.ts`, `packages/core/test/process.test.ts`

**Interfaces:**
- Consumes: `CoreInfo`, `readInfo`, `infoPath`, `runDir`, `makeClient` (Task 2); `makeLog` (Task 4); `makeThreads`, `api`, `Threads`, `Log`, `Token` (Task 5).
- Produces: `claim(root, info): { ok: true } | { ok: false; reason }`, `release(root, pid)`; `liveCore(root)` (Effect of `{ log, threads }`), `liveLayer(root)`; the executable `packages/core/src/main.ts --root <dir> --mode child|headless` (serves `api` with `HttpRouter.serve` on `BunHttpServer.layer({ unix })`, run by `BunRuntime.runMain`; prints `ready <socket>`; exit 2 when another core holds the project; exit 1 with `zarg-core: <reason>` on stderr when it cannot start; exit 0 when its parent goes away in child mode).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/lifecycle.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { infoPath, readInfo } from "@zarg/client"
import { claim, release } from "../src"

const roots: Array<string> = []
const fresh = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-life-"))
  roots.push(r)
  return r
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

describe("core.json", () => {
  test("claim writes a private file; a second live core is refused", () => {
    const root = fresh()
    expect(claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })).toEqual({ ok: true })
    expect(statSync(infoPath(root)).mode & 0o777).toBe(0o600)
    const other = claim(root, { pid: 1, socket: "s", token: "t", mode: "headless" })
    expect(other).toMatchObject({ ok: false })
  })

  test("a file left by a dead core is ignored", () => {
    const root = fresh()
    mkdirSync(join(root, ".zarg", "run"), { recursive: true })
    writeFileSync(infoPath(root), JSON.stringify({ pid: 999999, socket: "s", token: "t", mode: "child" }))
    expect(readInfo(root)).toBeUndefined()
    expect(claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })).toEqual({ ok: true })
  })

  test("release removes the file only for its own pid", () => {
    const root = fresh()
    claim(root, { pid: process.pid, socket: "s", token: "t", mode: "child" })
    release(root, 12345)
    expect(readInfo(root)?.pid).toBe(process.pid)
    release(root, process.pid)
    expect(readInfo(root)).toBeUndefined()
  })
})
```

`packages/core/test/process.test.ts` (the real core on a project with an empty `.env.schema`; no model is called):

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeClient, readInfo } from "@zarg/client"

const main = join(import.meta.dir, "..", "src", "main.ts")
const root = mkdtempSync(join(tmpdir(), "zarg-proc-"))
writeFileSync(join(root, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const start = async (mode: "child" | "headless") => {
  const proc = Bun.spawn([process.execPath, main, "--root", root, "--mode", mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return { proc, first: new TextDecoder().decode(value) }
}

describe("zarg-core process", () => {
  test("a child core serves its socket with a token, refuses a second core, and exits when stdin closes", async () => {
    const { proc, first } = await start("child")
    expect(first.startsWith("ready ")).toBe(true)
    const info = readInfo(root)!
    expect(info).toMatchObject({ pid: proc.pid, mode: "child" })

    expect(await Effect.runPromise(makeClient(info).threads())).toEqual([{ id: "main", focus: [], status: "idle" }])
    const denied = await Effect.runPromise(Effect.flip(makeClient({ socket: info.socket, token: "wrong" }).threads()))
    expect(denied.status).toBe(401)

    const second = Bun.spawnSync([process.execPath, main, "--root", root, "--mode", "headless"])
    expect(second.exitCode).toBe(2)
    expect(second.stderr.toString()).toContain("already running")

    proc.stdin.end()
    expect(await proc.exited).toBe(0)
    expect(readInfo(root)).toBeUndefined()
  }, 20_000)

  test("a core killed without cleanup leaves files behind; the next core starts anyway", async () => {
    const first = await start("child")
    first.proc.kill("SIGKILL")
    await first.proc.exited
    const second = await start("child")
    expect(second.first.startsWith("ready ")).toBe(true)
    expect(await Effect.runPromise(makeClient(readInfo(root)!).threads())).toHaveLength(1)
    second.proc.stdin.end()
    await second.proc.exited
  }, 20_000)

  test("a core that cannot start exits 1 with the reason on stderr and leaves no core.json", () => {
    const broken = mkdtempSync(join(tmpdir(), "zarg-proc-bad-"))
    mkdirSync(join(broken, ".zarg"))
    writeFileSync(join(broken, ".zarg", "config.toml"), "not = [valid toml\n")
    writeFileSync(join(broken, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
    const r = Bun.spawnSync([process.execPath, main, "--root", broken, "--mode", "child"], { stdin: "ignore" })
    rmSync(broken, { recursive: true, force: true })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain("invalid TOML")
    expect(readInfo(broken)).toBeUndefined()
  }, 20_000)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/core && mise x -- bun test test/lifecycle.test.ts test/process.test.ts`
Expected: FAIL (`claim` is not exported; `src/main.ts` does not exist).

- [ ] **Step 3: Implement**

`packages/core/src/lifecycle.ts`:

```ts
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type CoreInfo, infoPath, readInfo, runDir } from "@zarg/client"

/** Claim the project for this process, or explain who already holds it. */
export const claim = (root: string, info: CoreInfo): { ok: true } | { ok: false; reason: string } => {
  const live = readInfo(root)
  if (live !== undefined && live.pid !== info.pid) return { ok: false, reason: `a core is already running for this project (pid ${live.pid})` }
  mkdirSync(runDir(root), { recursive: true })
  writeFileSync(infoPath(root), JSON.stringify(info), { mode: 0o600 })
  chmodSync(infoPath(root), 0o600)
  return { ok: true }
}

/** Remove core.json and the socket, unless another core holds them now. */
export const release = (root: string, pid: number) => {
  const current = readInfo(root)
  if (current === undefined || current.pid === pid) {
    rmSync(infoPath(root), { force: true })
    rmSync(join(runDir(root), "core.sock"), { force: true })
  }
}
```

`packages/core/src/live.ts`:

```ts
import { BunServices } from "@effect/platform-bun"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Decisions, layer as decisionsLayer } from "@zarg/decisions"
import { GraphStore, layer as graphLayer } from "@zarg/graph"
import { type Bound } from "@zarg/kernel"
import { Config, Env, layer as envLayer, Model, redact } from "@zarg/model"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { gherkin } from "@zarg/plugin-gherkin/server"
import { openrouter } from "@zarg/provider-openrouter"
import { zargRouter } from "@zarg/provider-zarg-router"
import { type Asker, decisionsService, fsRead, graph, inquire, pluginService, Rlm, type Scope, settings } from "@zarg/rlm"
import { makeLog } from "./log"
import { makeThreads } from "./threads"

/** Everything a real core needs for a project: the 2a runtime, the thread log and the threads. */
export const liveCore = (root: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Config
    const model = yield* Model.Model
    const env = yield* Env
    const host = yield* PluginHost
    const store = yield* GraphStore
    const decisions = yield* Decisions
    const sensitive = yield* env.sensitive
    const rlmSettings = yield* settings(config.extra.rlm)
    const log = yield* makeLog(join(root, ".zarg", "threads"), (t) => redact(t, sensitive))
    const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))

    const makeRlm = (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => {
      const factory = (name: string, scope: Scope): Bound | undefined => {
        const ctx = { host, snapshot, scope }
        if (name === "Graph") return graph(ctx)
        if (name === "Gherkin") return pluginService(gherkin, ctx)
        if (name === "Fs:read") return fsRead({ root, scope, sensitive })
        if (name === "Inquire") return inquire(asker)
        if (name === "Decisions") return decisionsService(decisions as never)
        return undefined
      }
      return Rlm.make({ settings: rlmSettings, services: factory, roles: config.roles, decisions, observe }).pipe(
        Effect.provideService(Model.Model, model),
      )
    }
    const threads = yield* makeThreads({ log, agenda: (focus) => host.agenda(focus), makeRlm })
    return { log, threads }
  })

/** Layers for a project root: env, config, models, decisions, graph and plugins. */
export const liveLayer = (root: string) => {
  const base = Layer.merge(envLayer(root), BunServices.layer)
  const config = Layer.provideMerge(Config.layer({ userDir: join(homedir(), ".config", "zarg"), projectDir: root }), base)
  const model = Layer.provideMerge(Model.layer([zargRouter, openrouter]), config)
  const decisions = Layer.provideMerge(decisionsLayer(), model)
  const graphs = Layer.provideMerge(hostLayer([gherkin]), graphLayer(join(root, ".zarg", "graph")))
  return Layer.mergeAll(decisions, Layer.provideMerge(graphs, BunServices.layer))
}
```

`packages/core/src/main.ts`:

```ts
#!/usr/bin/env bun
// zarg-core: one per project. `--mode child` (default) exits with its parent; `--mode headless` runs until stopped.
import { randomBytes } from "node:crypto"
import { rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { runDir } from "@zarg/client"
import { claim, release } from "./lifecycle"
import { liveCore, liveLayer } from "./live"
import { api, Log, Threads, Token } from "./server"

const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string" } } })
const root = values.root ?? process.cwd()
const mode = values.mode === "headless" ? "headless" : "child"
const socket = join(runDir(root), "core.sock")
const token = randomBytes(24).toString("hex")
const owner = mode === "child" ? process.ppid : undefined

/** Completes when the parent CLI is gone: its stdin pipe closes or this process is re-parented. */
const parentGone = Effect.callback<void>((resume) => {
  const done = () => resume(Effect.void)
  process.stdin.on("end", done)
  process.stdin.on("close", done)
  process.stdin.resume()
  const timer = setInterval(() => {
    if (process.ppid !== owner) done()
  }, 1000)
  return Effect.sync(() => clearInterval(timer))
})

const program = Effect.gen(function* () {
  const claimed = claim(root, { pid: process.pid, socket, token, mode, ...(owner !== undefined ? { owner } : {}) })
  if (!claimed.ok) {
    console.error(claimed.reason)
    return yield* Effect.sync(() => process.exit(2))
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => release(root, process.pid)))
  const core = yield* liveCore(root)
  // A core killed without cleanup leaves its socket file; we hold the claim now, so it is safe to remove.
  rmSync(socket, { force: true })
  yield* Layer.build(
    HttpRouter.serve(api, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide([BunHttpServer.layer({ unix: socket }), Layer.succeed(Threads, core.threads), Layer.succeed(Log, core.log), Layer.succeed(Token, token)]),
    ),
  )
  console.log(`ready ${socket}`)
  // SIGINT and SIGTERM interrupt this fiber (runMain); finalizers stop the server and release core.json.
  yield* mode === "child" ? parentGone : Effect.never
}).pipe(Effect.scoped, Effect.provide(liveLayer(root)))

// Exit once finalizers ran, on success too: open handles (stdin, workers) would otherwise keep the process alive.
// A failure is written synchronously first: a piped stderr would lose an async log at process.exit.
BunRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      const e = Cause.squash(exit.cause)
      writeSync(2, `zarg-core: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    Runtime.defaultTeardown(exit, (code) => {
      onExit(code)
      process.exit(code)
    })
  },
})
```

Append to `packages/core/src/index.ts`:

```ts
export * from "./lifecycle"
```

Append to `.gitignore`:

```
.zarg/run/
.zarg/threads/
```

In `AGENTS.md`, add under "## Packages", after the `packages/rlm` line:

```md
- `packages/core` (`@zarg/core`): `zarg-core`, one per project: driver threads on RLMs, the AG-UI API on `.zarg/run/core.sock` (token in `.zarg/run/core.json`), thread logs in `.zarg/threads/`.
- `packages/client` (`@zarg/client`): attach to or start a core, the AG-UI client, and `reduce` (events → thread state). Never imports `@zarg/core` or a `/server` subpath.
```

and add `docs/superpowers/specs/2026-09-26-core-driver-tui-design.md` to the "Design:" line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (22 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/core .gitignore AGENTS.md
git commit -m "feat(core): zarg-core process: one per project, child or headless"
```
