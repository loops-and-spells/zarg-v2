# Phase 2b-2b: Plan and Implement in the Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running zarg core plans and implements changed cards on its own: after the graph is quiet, a durable reconcile pass runs a planner RLM and an implementer RLM per card in git worktrees, verifies, and lands one commit; passes show in the `plan` and `implement` threads, findings reach the driver's agenda, and stop cuts a pass short.

**Architecture:** `@zarg/rlm` gains the `plan`, `fix` and `resolve` presets (the `sync` preset goes). `@zarg/core/phases.ts` turns them into a `ReconcileSpec` (each card's RLM works in its worktree, with that worktree's graph); `@zarg/core/reconcile.ts` runs `@zarg/reconcile`'s reconciler on a durable engine, projects passes onto two view threads through the shared activity helper, and turns findings into agenda items. The CLI gains `zarg affected` and `zarg checkpoint`, which the new `zarg-implement` skill uses when no core runs.

**Tech Stack:** bun 1.4.2 (via mise), Effect `4.0.0-rc.117` (`effect/unstable/workflow`, `effect/unstable/cluster`), `@zarg/reconcile`, `@zarg/rlm`, `@zarg/core`, `@zarg/cli`.

**Spec:** `docs/superpowers/specs/2026-09-26-plan-implement-design.md`. Plan 2b-2a (`docs/superpowers/plans/2026-09-26-phase-2b-2a-reconcile-loop.md`) built the loop. Intent: `intent/zarg.md`.

## Global Constraints

- Run bun only as `mise x -- bun ...`; tests spawn `process.execPath`.
- No real model in `mise run verify`: phases are tested with stub models; the core end to end uses stub mode (`ZARG_CORE_STUB`). `mise run smoke:implement` is the live test; it loads the developer's plan and implement models, so **ask before running it**.
- Downstream phases never edit requirements: whatever a planner, implementer or fix RLM changes under `.zarg/` in its worktree is discarded.
- Every card's RLMs work in that card's worktree; findings go to `.zarg/reconcile/findings.json`; the engine database is `.zarg/reconcile/cluster.db` (a directory that keeps itself out of git).
- `mise run verify` must pass at the end of every task. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every code block was prototyped and passes (`mise run verify` green on the prototype).

### Deliberate differences from the spec

- **Stop** uses a stop signal of its own, not `Workflow.interrupt`: a probe showed `interrupt` does not cut a running Activity short. Running cards race the signal (their RLMs and shell commands are killed); the pass records "stop requested" at each step boundary and ends as failed, with no findings, so it never resumes.
- The **planner** returns its plan as its result and the core writes `.zarg/plans/<card>.md` (with the card's title and hash); the planner itself only reads (`Graph`, `Fs:read`, `Decisions`).
- The **`zarg-implement` skill** has Claude Code act as planner and implementer under the pass contract (plan files, `// @card` tags, verify, one commit with `.zarg/reconciled.json`), using the new `zarg affected` and `zarg checkpoint` commands. The spec said the skill runs one pass in-process.
- The engine database lives at `.zarg/reconcile/cluster.db` (spec: `.zarg/run/`), because other projects may not ignore `.zarg/run/`.
- Removed cards lose their plan files; their code stays (what implement owns in code is the code-ownership spec).
- Stub mode maps `plan` and `implement` to the stub model too.

## Review Focus

1. A planner or implementer that edits `.zarg/graph` in its worktree must not change requirements in the commit (Task 5 test).
2. A card the planner calls contradictory must become an `unplannable` finding while the other cards still land (Task 5 test).
3. Stop on the `implement` thread must end a running pass quickly with nothing landed and "The pass stopped." in the thread (Task 6 test; the loop half in Task 2).
4. A real core must reconcile a card written to the graph into one commit with its plan and code, leaving a clean `git status` (Task 6 test).
5. After `zarg checkpoint` and a commit, `zarg affected` must report nothing left (Task 7 test).

---

### Task 1: Presets for plan and implement

**Files:**
- Modify: `packages/rlm/src/presets.ts`
- Test: `packages/rlm/test/fold.test.ts`, `packages/rlm/test/rlm.test.ts`

**Interfaces:**
- Produces: presets `plan` (Graph, Fs:read, Decisions, Rlm; role `plan`; result `plan`), `implement-card` (role `implement`; result gains `blocked?`), `fix` (Graph, Fs, Sh, Verify, Rlm; role `implement`; result `text`), `resolve` (Fs, Sh, Rlm; role `implement`; result `resolve`); results `plan: { plan?, blocked? }`, `implement-card: { files, summary, blocked? }`, `resolve: { resolved }`. The `sync` preset is removed.

- [ ] **Step 1: Update the tests to the new presets**

The fold tests used `sync` as a parent that spawns `implement-card`; they now declare a test preset `lead`. Apply:

```diff
--- a/packages/rlm/test/fold.test.ts
+++ b/packages/rlm/test/fold.test.ts
@@ -23,7 +23,7 @@
     expect(planProblems({ children: [child("a")] }, ["research"])).toEqual(["a plan has 2 to 8 children, got 1"])
     expect(planProblems({ children: [child("a"), child("a")] }, ["research"])).toContain('duplicate child id "a"')
     expect(planProblems({ children: [child("a", ["zz"]), child("b")] }, ["research"])).toContain('a depends on unknown "zz"')
-    expect(planProblems({ children: [child("a", [], "sync"), child("b")] }, ["research"])[0]).toContain('preset "sync" is not one you may spawn')
+    expect(planProblems({ children: [child("a", [], "fix"), child("b")] }, ["research"])[0]).toContain('preset "fix" is not one you may spawn')
     expect(planProblems({ children: [child("a", ["b"]), child("b", ["a"])] }, ["research"])).toEqual(["dependsOn has a cycle"])
   })
 })
@@ -70,7 +70,7 @@
   return Effect.runPromise(
     Effect.gen(function* () {
       const s = yield* settings(raw)
-      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", sync: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000, ...(observe ? { observe } : {}) })
+      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", implement: "stub:m" }, decisions: d.service, cellTimeoutMs: 5000, ...(observe ? { observe } : {}) })
       return yield* Effect.exit(rlm.exec(spec))
     }).pipe(Effect.provide(stub.layer)),
   ).then((exit) => ({ exit, seen: stub.seen }))
@@ -147,14 +147,15 @@
         plan: [planText(plan)],
         "implement-card": [{ cell: 'yield* Rlm.done({ value: { files: ["src/a.ts"], summary: "edited" } })' }],
         research: [researchDone("fine")],
-        sync: [{ cell: "yield* Rlm.done({ value: JSON.stringify(children.map((c: any) => [c.id, c.ok, c.kind ?? null])) })" }],
+        lead: [{ cell: "yield* Rlm.done({ value: JSON.stringify(children.map((c: any) => [c.id, c.ok, c.kind ?? null])) })" }],
       },
-      { task: "big", preset: "sync", scope: { paths: ["src/**"] } },
+      { task: "big", preset: "lead", scope: { paths: ["src/**"] } },
       decisions(false),
+      { presets: { lead: { layer: ["Graph", "Fs", "Sh", "Verify", "Decisions", "Rlm"], spawns: ["implement-card", "research"], role: "implement", result: "text", verify: "gate" } } },
     )
     gatePasses = true
     expect(JSON.parse(value(r))).toEqual([["i1", false, "verify"], ["r1", true, null]])
-    const note = String(r.seen.filter((s) => s.preset === "sync")[0]!.messages.at(-1)?.content)
+    const note = String(r.seen.filter((s) => s.preset === "lead")[0]!.messages.at(-1)?.content)
     expect(note).toContain("2 tests failed")
   })
 
--- a/packages/rlm/test/rlm.test.ts
+++ b/packages/rlm/test/rlm.test.ts
@@ -36,7 +36,7 @@
   return Effect.runPromise(
     Effect.gen(function* () {
       const s = yield* settings(presetsRaw)
-      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", sync: "stub:m" }, cellTimeoutMs: 5000 })
+      const rlm = yield* Rlm.make({ settings: s, services: factory, roles: { driver: "stub:m", implement: "stub:m" }, cellTimeoutMs: 5000 })
       return yield* Effect.exit(rlm.exec(spec))
     }).pipe(Effect.provide(stub.layer)),
   ).then((exit) => ({ exit, seen: stub.seen }))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/rlm && mise x -- bun test test/fold.test.ts`
Expected: FAIL in the gate test: its `implement-card` child still has role `sync`, which the test's roles (`driver`, `implement`) do not map to a model.

- [ ] **Step 3: Implement**

```diff
--- a/packages/rlm/src/presets.ts
+++ b/packages/rlm/src/presets.ts
@@ -39,8 +39,11 @@
 /** The presets from the spec; `[rlm.presets.*]` in config overrides them by name. */
 export const DEFAULT_PRESETS: Readonly<Record<string, Preset>> = {
   driver: { layer: ["Graph", "Gherkin", "Inquire", "Fs:read", "Decisions", "Rlm"], spawns: ["research", "driver"], role: "driver", budget: { turns: 25 }, result: "text", verify: "none" },
-  sync: { layer: ["Graph", "Fs", "Sh", "Verify", "Agenda", "Decisions", "Rlm"], spawns: ["implement-card", "research"], role: "sync", budget: { turns: 40 }, result: "text", verify: "gate" },
-  "implement-card": { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: ["research"], role: "sync", budget: { turns: 25 }, result: "implement-card", verify: "gate" },
+  // Plan and implement phases (the reconcile loop): each runs per card in its own worktree.
+  plan: { layer: ["Graph", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "plan", budget: { turns: 20 }, result: "plan", verify: "none" },
+  "implement-card": { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: ["research"], role: "implement", budget: { turns: 25 }, result: "implement-card", verify: "gate" },
+  fix: { layer: ["Graph", "Fs", "Sh", "Verify", "Rlm"], spawns: [], role: "implement", budget: { turns: 15 }, result: "text", verify: "none" },
+  resolve: { layer: ["Fs", "Sh", "Rlm"], spawns: [], role: "implement", budget: { turns: 10 }, result: "resolve", verify: "none" },
   research: { layer: ["Graph", "Fs:read", "Decisions", "Rlm"], spawns: ["research"], role: "driver", budget: { turns: 15 }, result: "research", verify: "none" },
 }
 
@@ -75,5 +78,8 @@
 export const RESULTS: Readonly<Record<string, Schema.Codec<any, any>>> = {
   text: Schema.String,
   research: Schema.Struct({ findings: Schema.Array(Schema.String), sources: Schema.Array(Schema.String) }),
-  "implement-card": Schema.Struct({ files: Schema.Array(Schema.String), summary: Schema.String }),
+  /** The plan's Markdown sections (Approach, Files, Tests, Depends on), or why the card cannot be planned. */
+  plan: Schema.Struct({ plan: Schema.optionalKey(Schema.String), blocked: Schema.optionalKey(Schema.String) }),
+  "implement-card": Schema.Struct({ files: Schema.Array(Schema.String), summary: Schema.String, blocked: Schema.optionalKey(Schema.String) }),
+  resolve: Schema.Struct({ resolved: Schema.Boolean }),
 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/rlm && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (50 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/rlm
git commit -m "feat(rlm): plan, implement-card, fix and resolve presets; sync retired"
```

---

### Task 2: Stop a pass; pass worktree cleanup tested

**Files:**
- Modify: `packages/reconcile/src/pass.ts`
- Test: `packages/reconcile/test/pass.test.ts`, `packages/reconcile/test/worktree.test.ts`

**Interfaces:**
- Produces: `ReconcileSpec.stop?: { requested(): boolean; wait: Effect<void> }` — running items race `wait`; `requested()` is recorded as an Activity at each step boundary (`stopped:<site>`); a stopped pass returns `{ status: "failed", landed: [], failed: [] }` and raises no findings. `gcPasses` gets its first test.

- [ ] **Step 1: Write the failing tests**

```diff
--- a/packages/reconcile/test/pass.test.ts
+++ b/packages/reconcile/test/pass.test.ts
@@ -185,6 +185,31 @@
     expect(results.map((x) => x.status).sort()).toEqual(["landed", "nothing"])
   })
 
+  test("stop ends a running pass at once: nothing lands, no findings, and it does not resume", async () => {
+    const r = repo()
+    graph(r, ["UX-0001"])
+    const spec = stubSpec(r)
+    let requested = false
+    let release: () => void = () => {}
+    const signal = new Promise<void>((resolve) => (release = resolve))
+    const stoppable = {
+      ...spec,
+      stop: { requested: () => requested, wait: Effect.promise(() => signal) },
+      phases: spec.phases.map((p) => (p.name === "implement" ? { ...p, run: (item: string, cwd: string) => Effect.andThen(Effect.sleep("30 seconds"), p.run(item, cwd)) } : p)),
+    }
+    const file = db()
+    const t0 = Date.now()
+    const running = runPass(stoppable, file)
+    await Bun.sleep(1000)
+    requested = true
+    release()
+    expect(await running).toMatchObject({ status: "failed" })
+    expect(Date.now() - t0).toBeLessThan(10_000)
+    expect(sh(r, "git log --format=%s")).toBe("init")
+    expect(spec.findings.list()).toEqual([])
+    expect(await runPass(stoppable, file)).toMatchObject({ status: "failed" })
+  }, 20_000)
+
   test("a removed card's plan and code are deleted in the next pass", async () => {
     const r = repo()
     graph(r, ["UX-0001", "UX-0002"])
--- a/packages/reconcile/test/worktree.test.ts
+++ b/packages/reconcile/test/worktree.test.ts
@@ -2,7 +2,7 @@
 import { existsSync, readFileSync, writeFileSync } from "node:fs"
 import { join } from "node:path"
 import { Effect } from "effect"
-import { ensureWorktree, mergeBranches, removeWorktree, worktreeRoot } from "../src"
+import { ensureWorktree, gcPasses, mergeBranches, removeWorktree, worktreeRoot } from "../src"
 import { cleanup, repo, sh, write } from "./repo"
 
 afterAll(cleanup)
@@ -26,6 +26,21 @@
   })
 })
 
+describe("gcPasses", () => {
+  test("keeps the newest passes' worktrees and removes the rest with their branches", async () => {
+    const r = repo()
+    const base = sh(r, "git rev-parse HEAD")
+    for (const p of ["p1", "p2", "p3", "p4"]) {
+      await run(ensureWorktree(r, join(worktreeRoot(r), p, "main"), `zarg/${p}/main`, base))
+      await Bun.sleep(20)
+    }
+    await run(gcPasses(r, 3, (p, name) => `zarg/${p}/${name}`))
+    expect(existsSync(join(worktreeRoot(r), "p1"))).toBe(false)
+    expect(["p2", "p3", "p4"].every((p) => existsSync(join(worktreeRoot(r), p, "main")))).toBe(true)
+    expect(sh(r, "git branch --list 'zarg/p1/*'")).toBe("")
+  })
+})
+
 describe("mergeBranches", () => {
   const setup = () => {
     const r = repo()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/reconcile && mise x -- bun test test/pass.test.ts -t "stop ends"`
Expected: FAIL (timeout: the pass keeps running for 30 s; `stop` is ignored).

- [ ] **Step 3: Implement**

```diff
--- a/packages/reconcile/src/pass.ts
+++ b/packages/reconcile/src/pass.ts
@@ -48,6 +48,11 @@
   /** Landing attempts before a landing-blocked finding (spec: 10, one a minute). */
   readonly landAttempts: number
   readonly message: (items: ReadonlyArray<string>) => string
+  /**
+   * The developer's stop: `wait` completes when a stop is requested (running cards race it and are cut
+   * short); `requested` is checked between steps. A stopped pass ends as failed, without findings.
+   */
+  readonly stop?: { readonly requested: () => boolean; readonly wait: Effect.Effect<void> }
   /** Hold the graph write lock while landing, so no graph write lands halfway. */
   readonly withGraphLock?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
 }
@@ -118,6 +123,9 @@
     Effect.gen(function* () {
       const root = join(worktreeRoot(spec.repo), id)
       const main = join(root, "main")
+      // A stop is an outside event: record whether it was requested, so a resumed pass replays the same answer.
+      const isStopped = (site: string) => act(site, Schema.Boolean, Effect.sync(() => spec.stop?.requested() ?? false))
+      const stoppedResult = { status: "failed", landed: [], failed: [] } satisfies PassResult
       const branchOf = (name: string) => `zarg/${id}/${name}`
 
       const scope = yield* act(
@@ -165,7 +173,9 @@
               const wt = join(root, name(item))
               yield* ensureWorktree(spec.repo, wt, branchOf(name(item)), passHead)
               if (phase.setup && spec.setup) yield* spec.setup(wt)
+              const stopped = { ok: false, kind: "pass-error", title: "stopped", detail: "stopped by the developer" } as ItemOutcome
               const out = yield* phase.run(item, wt).pipe(
+                Effect.raceFirst(spec.stop ? Effect.as(spec.stop.wait, stopped) : Effect.never),
                 Effect.catchCause((cause) =>
                   Effect.succeed({ ok: false, kind: "pass-error", title: `${phase.name} failed for ${item}`, detail: String(cause).slice(0, 4000) } as ItemOutcome),
                 ),
@@ -175,6 +185,7 @@
             }),
           ).pipe(Effect.map((out) => [item, out as ItemOutcome] as const))
         const outcomes = yield* Effect.all(live.map(runItem), { concurrency: spec.maxParallel })
+        if (yield* isStopped(`stopped:${phase.name}`)) return stoppedResult
         for (const [item, out] of outcomes) if (!out.ok) failures.set(item, out)
         live = live.filter((i) => !failures.has(i))
         const conflicts = yield* act(
@@ -204,7 +215,7 @@
               v = yield* spec.verify(main)
             }
             return v
-          }),
+          }).pipe(Effect.raceFirst(spec.stop ? Effect.as(spec.stop.wait, { passed: false, output: "stopped" }) : Effect.never)),
         )
       const report = (site: string, extra: ReadonlyArray<{ kind: FindingKind; title: string; detail: string; about: ReadonlyArray<string> }>) =>
         act(
@@ -217,7 +228,9 @@
         )
       const failed = () => [...failures.keys()].sort()
 
+      if (yield* isStopped("stopped:verify")) return stoppedResult
       const verified = yield* gate("verify")
+      if (yield* isStopped("stopped:verified")) return stoppedResult
       if (!verified.passed) {
         yield* report("verify", [{ kind: "verify-failing", title: "verify still fails after the fix attempts", detail: verified.output.slice(-4000), about: live }])
         return { status: "failed", landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
@@ -232,6 +245,7 @@
           rmSync(join(main, LEGACY_CHECKPOINT), { force: true })
           return yield* commitAll(main, spec.message(live))
         })
+      if (yield* isStopped("stopped:commit")) return stoppedResult
       let commit = yield* act("commit", Schema.String, squash(payload.base, payload.graph))
       let base = payload.base
 
@@ -272,6 +286,7 @@
           yield* report(`land:${attempt}`, [{ kind: "landing-blocked", title: "the implementation commit cannot land", detail, about: live }])
           return { status: "failed", commit, landed: [], failed: [...live, ...failed()].sort() } satisfies PassResult
         }
+        if (yield* isStopped(`stopped:land:${attempt}`)) return stoppedResult
         yield* DurableClock.sleep({ name: `land-wait:${attempt}`, duration: spec.landRetry })
       }
 
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/reconcile && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (45 tests).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/reconcile
git commit -m "feat(reconcile): stop cuts a running pass short; nothing lands, no findings"
```

---

### Task 3: The `[reconcile]` config section and the graph lock

**Files:**
- Modify: `packages/model/src/config.ts`, `packages/plugin/src/server/host.ts`
- Test: `packages/model/test/config.test.ts`, `packages/plugin/test/host.test.ts`

**Interfaces:**
- Produces: `[reconcile]` is a known config section (`config.extra.reconcile`); `PluginHost.exclusive(effect)` runs an effect while no tool call commits (the host's write lock).

- [ ] **Step 1: Write the failing tests**

```diff
--- a/packages/model/test/config.test.ts
+++ b/packages/model/test/config.test.ts
@@ -63,6 +63,11 @@
     expect(e.key).toBe("providers.o.api_key")
   })
 
+  test("[reconcile] is passed through for the core", async () => {
+    const c = await load(undefined, "[reconcile]\nquiet_ms = 500\n")
+    expect(c.extra.reconcile).toEqual({ quiet_ms: 500 })
+  })
+
   test("unknown sections and malformed roles are errors", async () => {
     expect((await fail(undefined, "[nonsense]\na = 1\n")).message).toBe('unknown config section "nonsense"')
     expect((await fail(undefined, '[roles]\ndriver = "no-colon"\n')).key).toBe("roles.driver")
--- a/packages/plugin/test/host.test.ts
+++ b/packages/plugin/test/host.test.ts
@@ -1,6 +1,6 @@
 import { BunServices } from "@effect/platform-bun"
 import { describe, expect, test } from "bun:test"
-import { Effect, FileSystem, Layer } from "effect"
+import { Effect, Fiber, FileSystem, Layer } from "effect"
 import { GraphStore, hash, layer as graphLayer } from "@zarg/graph"
 import { layer as hostLayer, PluginHost } from "../src/server"
 import { notes } from "./fixture-plugin"
@@ -42,6 +42,22 @@
     expect(out.ids).toEqual(["T-0001", "T-0002", "T-0003", "T-0004"])
   })
 
+  test("exclusive holds tool calls until it finishes (landing uses it)", async () => {
+    const order = await run(
+      Effect.gen(function* () {
+        const host = yield* PluginHost
+        const log: Array<string> = []
+        const fiber = yield* Effect.forkChild(host.exclusive(Effect.andThen(Effect.sleep(100), Effect.sync(() => log.push("exclusive done")))))
+        yield* Effect.sleep(10)
+        yield* host.call("notes/add-topic", { name: "x" })
+        log.push("call done")
+        yield* Fiber.join(fiber)
+        return log
+      }),
+    )
+    expect(order).toEqual(["exclusive done", "call done"])
+  })
+
   test("unknown tool and invalid params are ToolErrors", async () => {
     const errs = await run(
       Effect.gen(function* () {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `(cd packages/model && mise x -- bun test test/config.test.ts); (cd packages/plugin && mise x -- bun test test/host.test.ts)`
Expected: FAIL: `unknown config section "reconcile"`; `host.exclusive is not a function`.

- [ ] **Step 3: Implement**

```diff
--- a/packages/model/src/config.ts
+++ b/packages/model/src/config.ts
@@ -16,7 +16,7 @@
 
 export class Config extends Context.Service<Config, ZargConfig>()("@zarg/model/Config") {}
 
-const KNOWN = new Set(["providers", "roles", "rlm"])
+const KNOWN = new Set(["providers", "roles", "rlm", "reconcile"])
 const VAR = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
 
 /** Expand `${VAR}` / `${VAR:-default}` in one string; `$${` stays a literal `${`. */
--- a/packages/plugin/src/server/host.ts
+++ b/packages/plugin/src/server/host.ts
@@ -42,6 +42,8 @@
     readonly lint: Effect.Effect<ReadonlyArray<Finding>, IoError>
     readonly agenda: (focus?: ReadonlySet<string>) => Effect.Effect<ReadonlyArray<AgendaItem>, IoError>
     readonly render: (focus?: ReadonlySet<string>) => Effect.Effect<string, IoError>
+    /** Run `effect` with no tool call committing meanwhile (e.g. while landing a commit that writes graph files). */
+    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
   }
 >()("@zarg/plugin/PluginHost") {}
 
@@ -138,6 +140,7 @@
         lint,
         agenda,
         render,
+        exclusive: Semaphore.withPermits(lock, 1),
       }
     }),
   )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `(cd packages/model && mise x -- bunx tsc -p . && mise x -- bun test); (cd packages/plugin && mise x -- bunx tsc -p . && mise x -- bun test)`
Expected: PASS (model 43, plugin 21).

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/model packages/plugin
git commit -m "feat(model,plugin): [reconcile] config section; PluginHost.exclusive"
```

---

### Task 4: Shared activity helper

**Files:**
- Create: `packages/core/src/activity.ts`
- Modify: `packages/core/src/thread.ts`
- Test: the existing `packages/core/test/thread.test.ts` and `packages/core/test/robust.test.ts` (unchanged; this is a refactor)

**Interfaces:**
- Produces: `makeActivity(log, threadId) → { observe(e: RlmEvent, prefix = ""), snapshot(): Draft, reset(): Draft }` — the RLM tree and transcript a thread shows; `prefix` keeps ids apart when several RLM runs share a thread (one run per card).

- [ ] **Step 1: Confirm the tests that pin today's behavior pass**

Run: `cd packages/core && mise x -- bun test test/thread.test.ts test/robust.test.ts`
Expected: PASS. They cover activity deltas, fresh trees per item and transcripts; they must stay green through the refactor.

- [ ] **Step 2: Extract**

`packages/core/src/activity.ts`:

```ts
import { Effect } from "effect"
import type { Rlm } from "@zarg/rlm"
import * as E from "./events"
import type { ThreadLog } from "./log"

/**
 * The RLM tree a thread shows (ACTIVITY_SNAPSHOT / ACTIVITY_DELTA) and its transcript. `prefix` keeps ids
 * apart when several independent RLM runs share one thread (the reconcile threads: one run per card).
 */
export const makeActivity = (log: ThreadLog, threadId: string) => {
  const nodes = new Map<string, Record<string, unknown>>()
  const messageId = `${threadId}-activity`
  const observe = (e: Rlm.RlmEvent, prefix = "") => {
    const id = `${prefix}${e.id}`
    // Transcripts get what each RLM was asked and did; the activity tree gets its shape and status.
    if (e.type === "step") {
      const { type, id: _, ...rest } = e
      Effect.runSync(log.transcript(threadId, { type, rlm: id, ...rest }))
      return
    }
    if (e.type === "start") Effect.runSync(log.transcript(threadId, { type: "start", rlm: id, parent: e.parent !== undefined ? `${prefix}${e.parent}` : null, preset: e.preset, task: e.task }))
    const prev = nodes.get(id) ?? {}
    const next: Record<string, unknown> =
      e.type === "start"
        ? { id, parent: e.parent !== undefined ? `${prefix}${e.parent}` : null, preset: e.preset, scope: e.scope, depth: e.depth, turns: 0, budget: e.budget.turns, status: "running", decisions: [] }
        : e.type === "turn"
          ? { ...prev, turns: e.turn, tokens: e.tokens }
          : e.type === "atomize"
            ? { ...prev, decisions: [...((prev.decisions as Array<unknown>) ?? []), { kind: "atomize", atomic: e.atomic, criteria: e.criteria }] }
            : e.type === "plan"
              ? { ...prev, plan: e.children }
              : e.ok
                ? { ...prev, status: "done", turns: e.turns, tokens: e.tokens }
                : { ...prev, status: e.kind === "stopped" ? "stopped" : "failed", error: e.message }
    nodes.set(id, next)
    Effect.runSync(log.append(threadId, E.activityDelta(messageId, [{ op: "add", path: `/rlms/${id}`, value: next }])))
  }
  return {
    observe,
    /** The whole tree as a snapshot event (sent at the start of each run). */
    snapshot: () => E.activitySnapshot(messageId, { rlms: Object.fromEntries(nodes) }),
    /** Start a fresh tree (a new driver item, a new pass). */
    reset: () => {
      nodes.clear()
      return E.activitySnapshot(messageId, { rlms: {} })
    },
  }
}
```

Apply to `packages/core/src/thread.ts`:

```diff
--- a/packages/core/src/thread.ts
+++ b/packages/core/src/thread.ts
@@ -1,6 +1,7 @@
 import { Cause, Deferred, Effect, Exit, Fiber, Semaphore, Stream } from "effect"
 import type { AgendaItem } from "@zarg/plugin/server"
 import type { Answer, Asker, Question, Rlm, Scope } from "@zarg/rlm"
+import { makeActivity } from "./activity"
 import * as E from "./events"
 import type { Interrupt } from "@ag-ui/core"
 import type { WireEvent } from "./events"
@@ -49,7 +50,6 @@
     let pending: Pending | undefined
     let paused: Deferred.Deferred<void> | undefined
     const recent: Array<string> = []
-    const activity = new Map<string, Record<string, unknown>>()
     const emit = (d: E.Draft) => {
       if (d.type === "RUN_FINISHED" || d.type === "RUN_ERROR") open = false
       return log.append(threadId, d)
@@ -91,30 +91,8 @@
     }
 
     // RLM events become one activity message: the tree of RLMs working for this thread.
-    const observe = (e: Rlm.RlmEvent) => {
-      // Transcripts get what each RLM was asked and did; the activity tree gets its shape and status.
-      if (e.type === "step") {
-        const { type, id, ...rest } = e
-        Effect.runSync(log.transcript(threadId, { type, rlm: id, ...rest }))
-        return
-      }
-      if (e.type === "start") Effect.runSync(log.transcript(threadId, { type: "start", rlm: e.id, parent: e.parent ?? null, preset: e.preset, task: e.task }))
-      const prev = activity.get(e.id) ?? {}
-      const next: Record<string, unknown> =
-        e.type === "start"
-          ? { id: e.id, parent: e.parent ?? null, preset: e.preset, scope: e.scope, depth: e.depth, turns: 0, budget: e.budget.turns, status: "running", decisions: [] }
-          : e.type === "turn"
-            ? { ...prev, turns: e.turn, tokens: e.tokens }
-            : e.type === "atomize"
-              ? { ...prev, decisions: [...((prev.decisions as Array<unknown>) ?? []), { kind: "atomize", atomic: e.atomic, criteria: e.criteria }] }
-              : e.type === "plan"
-                ? { ...prev, plan: e.children }
-                : e.ok
-                  ? { ...prev, status: "done", turns: e.turns, tokens: e.tokens }
-                  : { ...prev, status: e.kind === "stopped" ? "stopped" : "failed", error: e.message }
-      activity.set(e.id, next)
-      Effect.runSync(emit(E.activityDelta(`${threadId}-activity`, [{ op: "add", path: `/rlms/${e.id}`, value: next }])))
-    }
+    const activity = makeActivity(log, threadId)
+    const observe = (e: Rlm.RlmEvent) => activity.observe(e)
 
     const scope: Scope = deps.focus.length > 0 ? { graph: { focus: deps.focus, k: 2 } } : {}
     const focusSet = deps.focus.length > 0 ? new Set(deps.focus) : undefined
@@ -137,8 +115,7 @@
           .filter((x) => x.length > 0)
           .join("\n\n")
         // Each item gets a fresh driver RLM, whose ids start over: start a fresh tree.
-        activity.clear()
-        yield* emit(E.activitySnapshot(`${threadId}-activity`, { rlms: {} }))
+        yield* emit(activity.reset())
         const outcome = yield* Effect.exit(deps.driver({ task, preset: "driver", scope }, asker, observe))
         if (Exit.isSuccess(outcome)) {
           yield* note("assistant", String(outcome.value.value))
@@ -183,7 +160,7 @@
           runId = input.runId
           open = true
           yield* emit(E.runStarted(threadId, runId))
-          yield* emit(E.activitySnapshot(`${threadId}-activity`, { rlms: Object.fromEntries(activity) }))
+          yield* emit(activity.snapshot())
           const resume = input.resume?.[0]
           if (resume !== undefined && pending !== undefined && resume.interruptId === pending.id) {
             const payload = (resume.payload ?? {}) as { choice?: string; other?: string }
```

- [ ] **Step 3: Run the tests to verify they still pass**

Run: `cd packages/core && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (40 tests, unchanged).

- [ ] **Step 4: Commit**

```bash
mise run verify
git add packages/core
git commit -m "refactor(core): activity helper shared by threads"
```

---

### Task 5: The plan and implement phases

**Files:**
- Create: `packages/core/src/phases.ts`
- Modify: `packages/core/package.json` (depends on `@zarg/reconcile`), `bun.lock`
- Test: `packages/core/test/phases.test.ts`

**Interfaces:**
- Consumes: `ReconcileSpec`, `ItemOutcome`, `Findings`, `GRAPH`, `gitRun` (`@zarg/reconcile`); presets (Task 1); `affectedCards` (`@zarg/plugin-gherkin/server`).
- Produces: `ReconcileConfig`, `ReconcileSettings { enabled, quietMs, maxParallel, setup?, verify, fixAttempts, landRetryMs, landAttempts }`, `reconcileSettings(raw)`; `PhaseDeps { repo, settings, sensitive, findings, makeRlm(services, observe), extra?, observe?(phase, item, e), withGraphLock?, stop? }`; `planPath(item)`; `reconcileSpec(deps): ReconcileSpec` (phases `plan` then `implement`; verify and setup run `bash -c` in the worktree; `fix` and `resolve` are RLMs; anything under `.zarg/` a phase RLM changes is discarded).

- [ ] **Step 1: Add the dependency**

Apply:

```diff
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -12,6 +12,7 @@
     "@zarg/plugin-gherkin": "workspace:*",
     "@zarg/provider-openrouter": "workspace:*",
     "@zarg/provider-zarg-router": "workspace:*",
+    "@zarg/reconcile": "workspace:*",
     "@zarg/rlm": "workspace:*",
     "effect": "^4.0.0-rc.117",
     "zod": "3"
```

Run: `mise x -- bun install`
Expected: `bun.lock` changes.

- [ ] **Step 2: Write the failing test**

`packages/core/test/phases.test.ts` (a real pass on a stub model that answers by preset):

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { Model, type StreamEvent } from "@zarg/model"
import { engineLayer, makeFindings, Pass, passLayer, workingGraphTree } from "@zarg/reconcile"
import { Rlm, settings } from "@zarg/rlm"
import { reconcileSettings, reconcileSpec } from "../src/phases"

const roots: Array<string> = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr}`)
  return p.stdout.toString().trim()
}
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const node = (root: string, n: { id: string; [k: string]: unknown }) => write(root, `.zarg/graph/nodes/${n.id}.json`, `${JSON.stringify(n)}\n`)

/** A repo with S-0001 and the given cards (uncommitted, as the driver leaves them). */
const project = (cards: ReadonlyArray<string>) => {
  const r = mkdtempSync(join(tmpdir(), "zarg-phases-"))
  roots.push(r)
  sh(r, "git init -q -b main && git config user.email t@t && git config user.name t && echo hi > README.md && git add -A && git commit -qm init")
  node(r, { id: "S-0001", type: "gherkin/state", props: { text: "the home page is shown" }, edges: [] })
  for (const c of cards) node(r, { id: c, type: "gherkin/card", props: { title: `Card ${c}`, when: `the user does ${c}` }, edges: [{ type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0001" }] })
  return r
}

/** A model that answers by preset (from the system prompt) with the card id substituted into the cell. */
const stub = (cells: Record<string, (card: string) => string>) =>
  Layer.succeed(Model.Model, {
    client: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
    stream: (req) => {
      const preset = /zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1] ?? "?"
      const card = /card (UX-\d+)/.exec(String(req.messages[1]?.content))?.[1] ?? ""
      const code = cells[preset]?.(card) ?? 'yield* Rlm.done({ value: "?" })'
      const events: ReadonlyArray<StreamEvent> = [
        { type: "toolCall", call: { id: `c${Math.random()}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
        { type: "done", finishReason: "tool_calls" },
      ]
      return Stream.fromIterable(events)
    },
  })

const PLAN = "## Approach\\nAdd a module.\\n## Files\\n- src/x.ts — new\\n## Tests\\n- test — works\\n## Depends on\\nnone"
const planner = (card: string) =>
  card === "UX-0002" ? 'yield* Rlm.done({ value: { blocked: "UX-0002 contradicts UX-0001" } })' : `yield* Rlm.done({ value: { plan: "${PLAN}" } })`
const implementer = (card: string) =>
  [
    `yield* Fs.write({ path: "src/${card}.ts", content: "// @card ${card}\\nexport const ok = true\\n" })`,
    // Requirements are read-only downstream: this edit must not survive.
    `yield* Fs.write({ path: ".zarg/graph/nodes/S-0001.json", content: "tampered" })`,
    `yield* Rlm.done({ value: { files: ["src/${card}.ts"], summary: "added" } })`,
  ].join("\n")

const pass = (repo: string, model: Layer.Layer<Model.Model>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Model.Model
      const s = yield* settings({})
      const findings = makeFindings(repo)
      const spec = reconcileSpec({
        repo,
        settings: yield* reconcileSettings({ verify: "test -f src/UX-0001.ts", land_retry_ms: 50, land_attempts: 2 }),
        sensitive: [],
        findings,
        makeRlm: (services, observe) => Rlm.make({ settings: s, services, roles: { plan: "stub:m", implement: "stub:m" }, observe, cellTimeoutMs: 10_000 }).pipe(Effect.provideService(Model.Model, m)),
      })
      const graph = yield* workingGraphTree(repo)
      const base = sh(repo, "git rev-parse HEAD")
      const out = yield* Pass.execute({ graph, branch: "main", base, attempt: 0 }).pipe(
        Effect.provide(passLayer(spec).pipe(Layer.provideMerge(engineLayer(join(mkdtempSync(join(tmpdir(), "zarg-db-")), "cluster.db"))))),
      )
      return { out, findings: findings.list() }
    }).pipe(Effect.provide(model)) as unknown as Effect.Effect<{ out: typeof Pass.successSchema.Type; findings: ReadonlyArray<{ kind: string; about: ReadonlyArray<string> }> }>,
  )

describe("plan and implement phases", () => {
  test("a card gets a plan file and code in one landed commit; requirements stay untouched", async () => {
    const r = project(["UX-0001"])
    const before = readFileSync(join(r, ".zarg/graph/nodes/S-0001.json"), "utf8")
    const { out } = await pass(r, stub({ plan: planner, "implement-card": implementer }))
    expect(out).toMatchObject({ status: "landed", landed: ["UX-0001"] })
    const plan = readFileSync(join(r, ".zarg/plans/UX-0001.md"), "utf8")
    expect(plan).toStartWith("# UX-0001 Card UX-0001\ncard: ")
    expect(plan).toContain("## Files\n- src/x.ts — new")
    expect(readFileSync(join(r, "src/UX-0001.ts"), "utf8")).toContain("// @card UX-0001")
    expect(readFileSync(join(r, ".zarg/graph/nodes/S-0001.json"), "utf8")).toBe(before)
    expect(sh(r, "git log -1 --format=%s")).toBe("feat: implement UX-0001")
  }, 60_000)

  test("a card the planner calls contradictory becomes an unplannable finding; the other card lands", async () => {
    const r = project(["UX-0001", "UX-0002"])
    const { out, findings } = await pass(r, stub({ plan: planner, "implement-card": implementer }))
    expect(out).toMatchObject({ status: "landed", landed: ["UX-0001"], failed: ["UX-0002"] })
    expect(findings.map((f) => [f.kind, f.about])).toEqual([["unplannable", ["UX-0002"]]])
    expect(existsSync(join(r, ".zarg/plans/UX-0002.md"))).toBe(false)
  }, 60_000)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/core && mise x -- bun test test/phases.test.ts`
Expected: FAIL (`../src/phases` does not exist).

- [ ] **Step 4: Implement**

`packages/core/src/phases.ts`:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, Schema } from "effect"
import { GraphStore, hash, layer as graphLayer } from "@zarg/graph"
import type { Bound } from "@zarg/kernel"
import { ConfigError, type SensitiveValue } from "@zarg/model"
import { layer as hostLayer, PluginHost } from "@zarg/plugin/server"
import { affectedCards, gherkin } from "@zarg/plugin-gherkin/server"
import { type Findings, GRAPH, gitRun, type ItemOutcome, type ReconcileSpec } from "@zarg/reconcile"
import { fs, fsRead, graph, type Rlm, runCommand, type Scope, sh, verify } from "@zarg/rlm"

/** `[reconcile]` in `.zarg/config.toml`. */
export const ReconcileConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  quiet_ms: Schema.optionalKey(Schema.Number),
  max_parallel: Schema.optionalKey(Schema.Number),
  setup: Schema.optionalKey(Schema.String),
  verify: Schema.optionalKey(Schema.String),
  fix_attempts: Schema.optionalKey(Schema.Number),
  land_retry_ms: Schema.optionalKey(Schema.Number),
  land_attempts: Schema.optionalKey(Schema.Number),
})

export interface ReconcileSettings {
  readonly enabled: boolean
  readonly quietMs: number
  readonly maxParallel: number
  readonly setup: string | undefined
  readonly verify: string
  readonly fixAttempts: number
  readonly landRetryMs: number
  readonly landAttempts: number
}

export const reconcileSettings = (raw: unknown) =>
  Effect.map(
    Schema.decodeUnknownEffect(ReconcileConfig)(raw ?? {}).pipe(Effect.mapError((e) => new ConfigError({ message: `[reconcile]: ${e.message}`, key: "reconcile" }))),
    (c): ReconcileSettings => ({
      enabled: c.enabled ?? true,
      quietMs: c.quiet_ms ?? 2000,
      maxParallel: c.max_parallel ?? 4,
      setup: c.setup,
      verify: c.verify ?? "mise run verify",
      fixAttempts: c.fix_attempts ?? 2,
      landRetryMs: c.land_retry_ms ?? 60_000,
      landAttempts: c.land_attempts ?? 10,
    }),
  )

export interface PhaseDeps {
  readonly repo: string
  readonly settings: ReconcileSettings
  readonly sensitive: ReadonlyArray<SensitiveValue>
  readonly findings: Findings
  /** An RLM runner over these services (settings, roles, model and decisions already bound). */
  readonly makeRlm: (services: (name: string, scope: Scope) => Bound | undefined, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.Rlm>
  /** Extra services by name (e.g. Decisions). */
  readonly extra?: (name: string) => Bound | undefined
  /** RLM events, tagged with the phase and card they work for. */
  readonly observe?: (phase: string, item: string, e: Rlm.RlmEvent) => void
  readonly withGraphLock?: ReconcileSpec["withGraphLock"]
  readonly stop?: ReconcileSpec["stop"]
}

/** The graph as the worktree at `cwd` has it (the pass's graph, not the developer's newer one). */
const withGraph = <A, E>(cwd: string, f: (g: { host: PluginHost["Service"]; store: GraphStore["Service"] }) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(Layer.provideMerge(hostLayer([gherkin]), graphLayer(join(cwd, GRAPH))).pipe(Layer.provide(BunServices.layer)))
      return yield* f({ host: Context.get(ctx, PluginHost), store: Context.get(ctx, GraphStore) })
    }),
  )

/** Requirements are never edited downstream: drop anything a phase changed under `.zarg/`. */
const keepRequirements = (cwd: string) =>
  Effect.gen(function* () {
    yield* gitRun(cwd, ["checkout", "-q", "HEAD", "--", ".zarg"])
    yield* gitRun(cwd, ["clean", "-q", "-fd", "--", ".zarg"])
  })

export const planPath = (item: string) => `.zarg/plans/${item}.md`

const planTask = (item: string, card: string) =>
  [
    `Write the implementation plan for card ${item}:`,
    "",
    card,
    "",
    "Read the code you need (Fs.list, Fs.read) and the cards around it (Graph.render, Graph.show).",
    "Finish with `yield* Rlm.done({ value: { plan } })`, where `plan` is Markdown with exactly these sections:",
    "## Approach",
    "## Files   (one line each: - path — what changes)",
    "## Tests   (one line each: - test name — what it proves)",
    "## Depends on   (card ids, or none)",
    "If the card contradicts another card or cannot be implemented as written, finish with `yield* Rlm.done({ value: { blocked: \"<why>\" } })` instead.",
  ].join("\n")

const implementTask = (item: string, card: string, plan: string) =>
  [
    `Implement card ${item} by following its plan.`,
    "",
    card,
    "",
    plan,
    "",
    `Write the code and its tests with Fs.write; tag the implementation and its tests with a \`// @card ${item}\` comment.`,
    "Run Verify.run until it passes. Never edit anything under .zarg/ (requirements and plans are read-only here).",
    "Finish with `yield* Rlm.done({ value: { files, summary } })`.",
    `If the card cannot be implemented as written (it contradicts another card), finish with \`yield* Rlm.done({ value: { files: [], summary: "", blocked: "<why>" } })\`.`,
  ].join("\n")

/** Plan and implement as reconcile phases, backed by RLMs working in each card's worktree. */
export const reconcileSpec = (deps: PhaseDeps): ReconcileSpec => {
  const run = (phase: string, preset: string, item: string, task: string, cwd: string) =>
    withGraph(cwd, ({ host, store }) =>
      Effect.gen(function* () {
        const snapshot = store.snapshot.pipe(Effect.mapError((e) => ({ _tag: e._tag, message: e.message })))
        const services = (name: string, scope: Scope): Bound | undefined => {
          const core = { root: cwd, scope, sensitive: deps.sensitive }
          if (name === "Graph") return graph({ host, snapshot, scope })
          if (name === "Fs") return fs(core)
          if (name === "Fs:read") return fsRead(core)
          if (name === "Sh") return sh(core)
          if (name === "Verify") return verify(core, ["bash", "-c", deps.settings.verify])
          return deps.extra?.(name)
        }
        const rlm = yield* deps.makeRlm(services, (e) => deps.observe?.(phase, item, e))
        const scope: Scope = { graph: { focus: [item], k: 2 }, paths: ["**"], kind: phase }
        return (yield* rlm.exec({ task, preset, scope })).value
      }),
    )
  const card = (cwd: string, item: string) =>
    withGraph(cwd, ({ host, store }) =>
      Effect.gen(function* () {
        const snap = yield* store.snapshot
        const node = snap.nodes.get(item)
        return { text: yield* host.render(new Set([item])), title: String(node?.props.title ?? item), hash: node ? hash(node) : "" }
      }),
    )
  const command = (cwd: string, script: string) => runCommand({ root: cwd, scope: {}, sensitive: deps.sensitive }, ["bash", "-c", script], 1_800_000)

  return {
    repo: deps.repo,
    affected: (before, after) => {
      const a = affectedCards(before, after)
      return { items: a.cards, removed: a.removed }
    },
    phases: [
      {
        name: "plan",
        setup: false,
        run: (item, cwd) =>
          Effect.gen(function* () {
            const c = yield* card(cwd, item)
            const out = (yield* run("plan", "plan", item, planTask(item, c.text), cwd)) as { plan?: string; blocked?: string }
            if (out.blocked !== undefined || out.plan === undefined) {
              return { ok: false, kind: "unplannable", title: `${item} cannot be planned`, detail: out.blocked ?? "the planner returned no plan" } satisfies ItemOutcome
            }
            const file = join(cwd, planPath(item))
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, `# ${item} ${c.title}\ncard: ${c.hash}\n\n${out.plan.trim()}\n`)
            return { ok: true } satisfies ItemOutcome
          }),
      },
      {
        name: "implement",
        setup: true,
        run: (item, cwd) =>
          Effect.gen(function* () {
            const c = yield* card(cwd, item)
            const planFile = join(cwd, planPath(item))
            const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "(no plan)"
            const out = (yield* run("implement", "implement-card", item, implementTask(item, c.text, plan), cwd).pipe(Effect.ensuring(Effect.orDie(keepRequirements(cwd))))) as { blocked?: string }
            if (out.blocked !== undefined) return { ok: false, kind: "blocked-card", title: `${item} cannot be implemented as written`, detail: out.blocked } satisfies ItemOutcome
            return { ok: true } satisfies ItemOutcome
          }),
      },
    ],
    ...(deps.settings.setup !== undefined ? { setup: (cwd: string) => Effect.asVoid(Effect.orDie(command(cwd, deps.settings.setup!))) } : {}),
    onRemoved: (items, cwd) => Effect.sync(() => items.forEach((i) => rmSync(join(cwd, planPath(i)), { force: true }))),
    verify: (cwd) =>
      Effect.map(Effect.orDie(command(cwd, deps.settings.verify)), (r) => ({ passed: r.exitCode === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(-8000) })),
    fix: (cwd, output, attempt) =>
      run(
        "implement",
        "fix",
        `fix-${attempt}`,
        `Verify fails after merging this pass's cards (attempt ${attempt}). Make it pass without changing what the cards require. Never edit anything under .zarg/.\n\n${output}\n\nFinish with \`yield* Rlm.done({ value: "<what you changed>" })\`.`,
        cwd,
      ).pipe(Effect.ensuring(Effect.orDie(keepRequirements(cwd))), Effect.asVoid, Effect.orElseSucceed(() => undefined)),
    resolve: (cwd, files) =>
      run(
        "implement",
        "resolve",
        "resolve",
        `These files have merge conflicts between cards implemented in parallel:\n${files.map((f) => `- ${f}`).join("\n")}\nEdit each so it keeps what both sides meant, with no conflict markers left. Finish with \`yield* Rlm.done({ value: { resolved: true } })\`, or \`{ resolved: false }\` if the two sides cannot both hold.`,
        cwd,
      ).pipe(
        Effect.map((v) => (v as { resolved: boolean }).resolved),
        Effect.orElseSucceed(() => false),
      ),
    findings: deps.findings,
    maxParallel: deps.settings.maxParallel,
    fixAttempts: deps.settings.fixAttempts,
    landRetry: `${deps.settings.landRetryMs} millis`,
    landAttempts: deps.settings.landAttempts,
    message: (items) => `feat: implement ${items.join(", ")}`,
    ...(deps.withGraphLock ? { withGraphLock: deps.withGraphLock } : {}),
    ...(deps.stop ? { stop: deps.stop } : {}),
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (42 tests).

- [ ] **Step 6: Commit**

```bash
mise run verify
git add packages/core bun.lock
git commit -m "feat(core): plan and implement phases backed by RLMs in card worktrees"
```

---

### Task 6: Reconcile in the core

**Files:**
- Create: `packages/core/src/reconcile.ts`
- Modify: `packages/core/src/live.ts`, `packages/core/src/threads.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/reconcile.test.ts`, `packages/core/test/process.test.ts`

**Interfaces:**
- Consumes: `makeActivity` (Task 4); `reconcileSpec`, `reconcileSettings` (Task 5); `startReconciler`, `passLayer`, `engineLayer`, `gcPasses`, `makeFindings` (`@zarg/reconcile`); `PluginHost.exclusive` (Task 3).
- Produces: `makeReconcile({ repo, settings, log, sensitive, makeRlm, extra?, withGraphLock?, dbFile? }) → { threads: [plan, implement], agenda(focus), notify, findings }` (scoped: the reconciler and engine close with the core); `ThreadsDeps.extra` (threads present from the start); the driver's agenda puts findings first; `/threads` lists `main`, `plan`, `implement`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/reconcile.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Exit, Layer, Scope, Stream } from "effect"
import { Model, type StreamEvent } from "@zarg/model"
import { Rlm, settings } from "@zarg/rlm"
import { makeLog, makeReconcile, reconcileSettings } from "../src"

const roots: Array<string> = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
const sh = (cwd: string, cmd: string) =>
  Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim()
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A model whose planner plans at once and whose implementer takes `implementMs` in a shell command. */
const model = (implementMs: number) =>
  Layer.succeed(Model.Model, {
    client: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    info: () => Effect.die("unused"),
    warm: () => Effect.void,
    stream: (req) => {
      const preset = /zarg (\S+) agent/.exec(String(req.messages[0]?.content))?.[1]
      const code =
        preset === "plan"
          ? 'yield* Rlm.done({ value: { plan: "## Approach\\nx\\n## Files\\n- a — b\\n## Tests\\n- t — t\\n## Depends on\\nnone" } })'
          : `yield* Sh.run({ command: "sleep ${implementMs / 1000}" })\nyield* Fs.write({ path: "src/a.ts", content: "ok" })\nyield* Rlm.done({ value: { files: ["src/a.ts"], summary: "s" } })`
      const events: ReadonlyArray<StreamEvent> = [
        { type: "toolCall", call: { id: `c${Math.random()}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } } },
        { type: "done", finishReason: "tool_calls" },
      ]
      return Stream.fromIterable(events)
    },
  })

const scopes: Array<Scope.Closeable> = []
afterAll(() => Promise.all(scopes.map((s) => Effect.runPromise(Scope.close(s, Exit.void)))))
const start = (repo: string, implementMs: number) =>
  (scopes.push(Effect.runSync(Scope.make())), Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Model.Model
      const s = yield* settings({})
      const log = yield* makeLog(join(repo, ".zarg", "threads"), (t) => t)
      const reconcile = yield* makeReconcile({
        repo,
        settings: yield* reconcileSettings({ quiet_ms: 100, verify: "true" }),
        log,
        sensitive: [],
        makeRlm: (services, observe) => Rlm.make({ settings: s, services, roles: { plan: "stub:m", implement: "stub:m" }, observe, cellTimeoutMs: 30_000 }).pipe(Effect.provideService(Model.Model, m)),
      })
      return { reconcile, log }
    }).pipe(Effect.provide(model(implementMs)), Effect.provideService(Scope.Scope, scopes.at(-1)!)) as never,
  )) as Promise<{ reconcile: Effect.Success<ReturnType<typeof makeReconcile>>; log: Effect.Success<ReturnType<typeof makeLog>> }>

const project = () => {
  const r = mkdtempSync(join(tmpdir(), "zarg-rec-"))
  roots.push(r)
  sh(r, "git init -q -b main && git config user.email t@t && git config user.name t && printf '.zarg/threads/\\n' > .gitignore && git add -A && git commit -qm init")
  return r
}
const card = (r: string) => {
  write(r, ".zarg/graph/nodes/S-0001.json", `${JSON.stringify({ id: "S-0001", type: "gherkin/state", props: { text: "home" }, edges: [] })}\n`)
  write(r, ".zarg/graph/nodes/UX-0001.json", `${JSON.stringify({ id: "UX-0001", type: "gherkin/card", props: { title: "Open", when: "the user opens it" }, edges: [{ type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0001" }] })}\n`)
}
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await Bun.sleep(50)
}

describe("reconcile in the core", () => {
  test("a pass shows on the plan and implement threads and ends with a summary", async () => {
    const r = project()
    const { reconcile, log } = await start(r, 0)
    card(r)
    await until(() => sh(r, "git log -1 --format=%s") === "feat: implement UX-0001")
    await until(() => log.all().some((e) => e.threadId === "implement" && e.type === "RUN_FINISHED"))
    const impl = log.all().filter((e) => e.threadId === "implement")
    expect(String(impl[0]?.type)).toBe("RUN_STARTED")
    expect(impl.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)).toEqual([expect.stringMatching(/^Landed UX-0001 in [0-9a-f]{7}\.$/)])
    expect(impl.some((e) => e.type === "ACTIVITY_DELTA" && JSON.stringify(e).includes("UX-0001/rlm-1"))).toBe(true)
    expect(log.all().some((e) => e.threadId === "plan" && e.type === "ACTIVITY_DELTA")).toBe(true)
    expect(reconcile.threads.map((t) => [t.id, t.status()])).toEqual([["plan", "idle"], ["implement", "idle"]])
  }, 30_000)

  test("stop on the implement thread interrupts the pass; nothing lands", async () => {
    const r = project()
    const { reconcile, log } = await start(r, 20_000)
    card(r)
    await until(() => reconcile.threads[1]!.status() === "running" && log.all().some((e) => e.threadId === "implement" && JSON.stringify(e).includes("implement-card")))
    await Effect.runPromise(reconcile.threads[1]!.stop)
    await until(() => reconcile.threads[1]!.status() === "idle", 10_000)
    expect(reconcile.threads[1]!.status()).toBe("idle")
    expect(sh(r, "git log -1 --format=%s")).toBe("init")
    expect(log.all().filter((e) => e.threadId === "implement" && e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)).toEqual(["The pass stopped."])
  }, 40_000)
})
```

Apply to `packages/core/test/process.test.ts` (the thread list now includes `plan` and `implement`; a stub-mode core reconciles a card end to end):

```diff
--- a/packages/core/test/process.test.ts
+++ b/packages/core/test/process.test.ts
@@ -25,7 +25,11 @@
     const info = readInfo(root)!
     expect(info).toMatchObject({ pid: proc.pid, mode: "child" })
 
-    expect(await Effect.runPromise(makeClient(info).threads())).toEqual([{ id: "main", focus: [], status: "idle" }])
+    expect(await Effect.runPromise(makeClient(info).threads())).toEqual([
+      { id: "main", focus: [], status: "idle" },
+      { id: "plan", focus: [], status: "idle" },
+      { id: "implement", focus: [], status: "idle" },
+    ])
     const denied = await Effect.runPromise(Effect.flip(makeClient({ socket: info.socket, token: "wrong" }).threads()))
     expect(denied.status).toBe(401)
 
@@ -44,7 +48,7 @@
     await first.proc.exited
     const second = await start("child")
     expect(second.first.startsWith("ready ")).toBe(true)
-    expect(await Effect.runPromise(makeClient(readInfo(root)!).threads())).toHaveLength(1)
+    expect(await Effect.runPromise(makeClient(readInfo(root)!).threads())).toHaveLength(3)
     second.proc.stdin.end()
     await second.proc.exited
   }, 20_000)
@@ -93,6 +97,50 @@
     Effect.runFork(Fiber.interrupt(follower))
   }, 20_000)
 
+  test("stub mode: a card written to the graph is planned, implemented and landed as one commit", async () => {
+    const project = mkdtempSync(join(tmpdir(), "zarg-proc-reconcile-"))
+    const git = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim()
+    git("git init -q -b main && git config user.email t@t && git config user.name t")
+    writeFileSync(join(project, ".env.schema"), "# @defaultSensitive=false\n# ---\n")
+    mkdirSync(join(project, ".zarg"))
+    writeFileSync(join(project, ".zarg", "config.toml"), '[reconcile]\nquiet_ms = 200\nverify = "test -f src/UX-0001.ts"\n')
+    writeFileSync(join(project, ".gitignore"), ".zarg/run/\n.zarg/threads/\n")
+    git("git add -A && git commit -qm init")
+    const stub = join(project, "..", `${project.split("/").pop()}-stub.json`)
+    writeFileSync(
+      stub,
+      JSON.stringify({
+        cells: [
+          'yield* Rlm.done({ value: { plan: "## Approach\\nAdd it.\\n## Files\\n- src/UX-0001.ts — new\\n## Tests\\n- none — stub\\n## Depends on\\nnone" } })',
+          'yield* Fs.write({ path: "src/UX-0001.ts", content: "// @card UX-0001\\nexport const ok = true\\n" })\nyield* Rlm.done({ value: { files: ["src/UX-0001.ts"], summary: "added" } })',
+        ],
+      }),
+    )
+    const proc = Bun.spawn([process.execPath, main, "--root", project, "--mode", "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ZARG_CORE_STUB: stub } })
+    await proc.stdout.getReader().read()
+    mkdirSync(join(project, ".zarg", "graph", "nodes"), { recursive: true })
+    writeFileSync(join(project, ".zarg/graph/nodes/S-0001.json"), `${JSON.stringify({ id: "S-0001", type: "gherkin/state", props: { text: "the home page is shown" }, edges: [] })}\n`)
+    writeFileSync(
+      join(project, ".zarg/graph/nodes/UX-0001.json"),
+      `${JSON.stringify({ id: "UX-0001", type: "gherkin/card", props: { title: "Open home", when: "the user opens the app" }, edges: [{ type: "gherkin/arrives", to: "S-0001" }, { type: "gherkin/then", to: "S-0001" }] })}\n`,
+    )
+    const until = Date.now() + 30_000
+    while (git("git log -1 --format=%s") !== "feat: implement UX-0001" && Date.now() < until) await Bun.sleep(200)
+    proc.stdin.end()
+    await proc.exited
+    expect(git("git log -1 --format=%s")).toBe("feat: implement UX-0001")
+    expect(git("git show --name-only --format= HEAD").split("\n").sort()).toEqual([
+      ".zarg/graph/nodes/S-0001.json",
+      ".zarg/graph/nodes/UX-0001.json",
+      ".zarg/plans/UX-0001.md",
+      ".zarg/reconciled.json",
+      "src/UX-0001.ts",
+    ])
+    expect(git("git status --porcelain")).toBe("")
+    rmSync(project, { recursive: true, force: true })
+    rmSync(stub, { force: true })
+  }, 60_000)
+
   test("a core that cannot start exits 1 with the reason on stderr and leaves no core.json", () => {
     const broken = mkdtempSync(join(tmpdir(), "zarg-proc-bad-"))
     mkdirSync(join(broken, ".zarg"))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/core && mise x -- bun test test/reconcile.test.ts test/process.test.ts`
Expected: FAIL (`makeReconcile` is not exported; the core lists only `main`; the card is never implemented).

- [ ] **Step 3: Implement**

`packages/core/src/reconcile.ts`:

```ts
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { AgendaItem } from "@zarg/plugin/server"
import { engineLayer, gcPasses, makeFindings, Pass, type PassResult, passLayer, startReconciler } from "@zarg/reconcile"
import { makeActivity } from "./activity"
import * as E from "./events"
import type { WireEvent } from "./events"
import type { ThreadLog } from "./log"
import { type PhaseDeps, type ReconcileSettings, reconcileSpec } from "./phases"
import type { Thread } from "./thread"

export interface ReconcileDeps {
  readonly repo: string
  readonly settings: ReconcileSettings
  readonly log: ThreadLog
  readonly sensitive: PhaseDeps["sensitive"]
  readonly makeRlm: PhaseDeps["makeRlm"]
  readonly extra?: PhaseDeps["extra"]
  readonly withGraphLock?: PhaseDeps["withGraphLock"]
  /** The workflow store. Under `.zarg/reconcile/`, which keeps itself out of git. */
  readonly dbFile?: string
}

const summary = (r: PassResult) => {
  if (r.status === "nothing") return undefined
  const failed = r.failed.length > 0 ? ` ${r.failed.join(", ")} need your attention (see the driver's agenda).` : ""
  return r.status === "landed" ? `Landed ${r.landed.join(", ")} in ${r.commit?.slice(0, 7)}.${failed}` : `Nothing landed.${failed}`
}

/**
 * Plan and implement for the core: the reconciler watching the graph, passes on a durable engine, the
 * `plan` and `implement` threads showing each pass, and findings as agenda items for the driver.
 */
export const makeReconcile = (deps: ReconcileDeps) =>
  Effect.gen(function* () {
    const findings = makeFindings(deps.repo)
    const activity = { plan: makeActivity(deps.log, "plan"), implement: makeActivity(deps.log, "implement") }
    const emit = (thread: string, d: E.Draft) => Effect.runSync(deps.log.append(thread, d))
    let active: { readonly payload: typeof Pass.payloadSchema.Type; readonly runId: string } | undefined
    // Stop: a flag the pass checks between steps, and a signal running cards race (reset for each pass).
    let stopRequested = false
    let release = () => {}
    let signal = Promise.resolve()
    const armStop = () => {
      stopRequested = false
      signal = new Promise<void>((resolve) => (release = resolve))
    }

    const spec = reconcileSpec({
      repo: deps.repo,
      settings: deps.settings,
      sensitive: deps.sensitive,
      findings,
      makeRlm: deps.makeRlm,
      ...(deps.extra ? { extra: deps.extra } : {}),
      ...(deps.withGraphLock ? { withGraphLock: deps.withGraphLock } : {}),
      observe: (phase, item, e) => (phase === "plan" ? activity.plan : activity.implement).observe(e, `${item}/`),
      stop: { requested: () => stopRequested, wait: Effect.suspend(() => Effect.promise(() => signal)) },
    })
    const engine = passLayer(spec).pipe(Layer.provideMerge(engineLayer(deps.dbFile ?? join(deps.repo, ".zarg", "reconcile", "cluster.db"))))
    const runtime = ManagedRuntime.make(engine as Layer.Layer<Layer.Success<typeof engine>, Layer.Error<typeof engine>, never>)
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))

    // Each pass is one run on both threads: started, the RLM tree per card, a summary, finished.
    const execute = (payload: typeof Pass.payloadSchema.Type) =>
      Effect.gen(function* () {
        const runId = `pass-${crypto.randomUUID().slice(0, 8)}`
        active = { payload, runId }
        armStop()
        // Failed passes keep their worktrees for inspection; only the newest few.
        yield* gcPasses(deps.repo, 3, (pass, name) => `zarg/${pass}/${name}`).pipe(Effect.ignore)
        for (const t of ["plan", "implement"] as const) {
          emit(t, E.runStarted(t, runId))
          emit(t, activity[t].reset())
        }
        return yield* Effect.tryPromise(() => runtime.runPromise(Pass.execute(payload))).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              active = undefined
              const text = stopRequested ? "The pass stopped." : exit._tag === "Success" ? summary(exit.value) : "The pass failed; see the driver's agenda."
              if (text !== undefined) for (const d of E.textMessage(`implement-${crypto.randomUUID()}`, "assistant", text)) emit("implement", d)
              for (const t of ["plan", "implement"] as const) emit(t, E.runFinished(t, runId))
            }),
          ),
        )
      })

    const reconciler = startReconciler({ repo: deps.repo, quietMs: deps.settings.quietMs, findings, execute })
    yield* Effect.addFinalizer(() => Effect.sync(() => reconciler.close()))

    /** Stop the running pass: its cards are cut short, nothing lands, its worktrees stay; the next graph change starts a new pass. */
    const stop = Effect.sync(() => {
      if (active === undefined) return
      stopRequested = true
      release()
    })

    // The reconcile threads only show passes; posting a run to them starts nothing.
    const view = (id: "plan" | "implement"): Thread => ({
      id,
      focus: [],
      run: () => Stream.empty as Stream.Stream<WireEvent>,
      stop,
      status: () => (active !== undefined ? "running" : "idle"),
    })

    /** Findings about the thread's focus (or all, without one), first on the driver's agenda. */
    const agenda = (focus: ReadonlySet<string> | undefined): ReadonlyArray<AgendaItem> =>
      findings
        .list()
        .filter((f) => focus === undefined || f.about.length === 0 || f.about.some((c) => focus.has(c)))
        .map((f) => ({ id: f.id, title: f.title, detail: `${f.kind}: ${f.detail}`, about: f.about, priority: 0 }))

    return { threads: [view("plan"), view("implement")], agenda, notify: reconciler.notify, findings }
  })
```

Apply to `live.ts`, `threads.ts` and `index.ts`:

```diff
--- a/packages/core/src/live.ts
+++ b/packages/core/src/live.ts
@@ -13,6 +13,8 @@
 import { type Asker, decisionsService, fsRead, graph, inquire, pluginService, Rlm, type Scope, settings } from "@zarg/rlm"
 import { makeLog } from "./log"
 import { STUB_MODEL, stubLayer } from "./stub"
+import { reconcileSettings } from "./phases"
+import { makeReconcile } from "./reconcile"
 import { makeThreads } from "./threads"
 
 /**
@@ -23,7 +25,7 @@
   Effect.gen(function* () {
     const config = yield* Config.Config
     const roles: Readonly<Record<string, string>> = opts.stub
-      ? { ...Object.fromEntries(Object.keys(config.roles).map((r) => [r, STUB_MODEL])), driver: STUB_MODEL }
+      ? { ...Object.fromEntries(Object.keys(config.roles).map((r) => [r, STUB_MODEL])), driver: STUB_MODEL, plan: STUB_MODEL, implement: STUB_MODEL }
       : config.roles
     const model = yield* Model.Model
     const env = yield* Env
@@ -49,7 +51,24 @@
         Effect.provideService(Model.Model, model),
       )
     }
-    const threads = yield* makeThreads({ log, agenda: (focus) => host.agenda(focus), makeRlm })
+    // Plan and implement: the reconcile loop, unless `[reconcile] enabled = false`.
+    const reconcileConfig = yield* reconcileSettings(config.extra.reconcile)
+    const reconcile = reconcileConfig.enabled
+      ? yield* makeReconcile({
+          repo: root,
+          settings: reconcileConfig,
+          log,
+          sensitive,
+          makeRlm: (services, observe) =>
+            Rlm.make({ settings: rlmSettings, services, roles, decisions, observe }).pipe(Effect.provideService(Model.Model, model)),
+          extra: (name) => (name === "Decisions" ? decisionsService(decisions as never) : undefined),
+          // Landing writes graph files: no driver write may land halfway through it.
+          withGraphLock: (effect) => host.exclusive(effect),
+        })
+      : undefined
+    const agenda = (focus: ReadonlySet<string> | undefined) =>
+      Effect.map(host.agenda(focus), (items) => [...(reconcile?.agenda(focus) ?? []), ...items])
+    const threads = yield* makeThreads({ log, agenda, makeRlm, extra: reconcile?.threads ?? [] })
     return { log, threads, driver: roles.driver }
   })
 
--- a/packages/core/src/threads.ts
+++ b/packages/core/src/threads.ts
@@ -9,6 +9,8 @@
   readonly agenda: ThreadDeps["agenda"]
   /** An RLM runner whose Inquire uses `asker` and whose events go to `observe`. */
   readonly makeRlm: (asker: Asker, observe: (e: Rlm.RlmEvent) => void) => Effect.Effect<Rlm.Rlm>
+  /** Threads that exist from the start besides `main` (the `plan` and `implement` views). */
+  readonly extra?: ReadonlyArray<Thread>
 }
 
 /** Threads by id, created on first use. `main` exists from the start. */
@@ -24,6 +26,7 @@
         driver: (spec, asker, observe) => Effect.flatMap(deps.makeRlm(asker, observe), (rlm) => rlm.exec(spec)),
       })
     threads.set("main", yield* create("main", []))
+    for (const t of deps.extra ?? []) threads.set(t.id, t)
     const registry: Threads["Service"] = {
       get: (id, focus) =>
         Effect.gen(function* () {
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -5,3 +5,6 @@
 export * from "./threads"
 export * from "./lifecycle"
 export * from "./stub"
+export * from "./activity"
+export * from "./phases"
+export * from "./reconcile"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (45 tests). The end-to-end test takes a few seconds: the core notices the card after its quiet period, plans and implements it on the stub model, and lands `feat: implement UX-0001`.

- [ ] **Step 5: Commit**

```bash
mise run verify
git add packages/core
git commit -m "feat(core): plan and implement run in the core: threads, findings on the agenda, stop"
```

---

### Task 7: CLI commands, the zarg-implement skill, docs and the live smoke test

**Files:**
- Modify: `packages/cli/src/commands.ts`, `packages/cli/package.json`, `bun.lock`, `mise.toml`, `.zarg/config.toml`, `AGENTS.md`, `docs/superpowers/specs/2026-09-25-harness-architecture-design.md`, `.claude/skills/zarg-drive/SKILL.md`
- Create: `.claude/skills/zarg-implement/SKILL.md`, `packages/cli/smoke/implement.ts`
- Delete: `.claude/skills/zarg-sync/`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `baseTree`, `workingGraphTree`, `snapshotAtTree`, `CHECKPOINT`, `LEGACY_CHECKPOINT` (`@zarg/reconcile`); `affectedCards`; `connect` (`@zarg/client`); `coreCommand` (`packages/cli/src/tui/run.tsx`).
- Produces: `zarg affected` → `{ base, graph, cards, removed }`; `zarg checkpoint` → writes `.zarg/reconciled.json` (and removes a legacy `.zarg/sync.json`), prints `{ graph }`; `mise run smoke:implement`.

- [ ] **Step 1: Write the failing test**

```diff
--- a/packages/cli/test/cli.test.ts
+++ b/packages/cli/test/cli.test.ts
@@ -164,3 +164,24 @@
     }
   }, 30_000)
 })
+
+describe("zarg affected and checkpoint", () => {
+  test("affected lists the cards to reconcile; checkpoint records the graph so nothing is left", () => {
+    const root = mkdtempSync(join(tmpdir(), "zarg-affected-"))
+    const g = (...args: Array<string>) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root })
+    g("init", "-q")
+    try {
+      zargIn(root, "tool", "call", "gherkin/add-state", '{"text":"the home page is shown","entry":true}')
+      zargIn(root, "tool", "call", "gherkin/add-card", JSON.stringify({ title: "Open pricing", when: "the user clicks Pricing", arrives: { id: "S-0001" }, then: [{ text: "the plan picker is shown" }] }))
+      const a = JSON.parse(zargIn(root, "affected").out)
+      expect(a).toMatchObject({ cards: ["UX-0001"], removed: [] })
+      const c = JSON.parse(zargIn(root, "checkpoint").out)
+      expect(c.graph).toBe(a.graph)
+      g("add", "-A")
+      g("commit", "-qm", "feat: implement UX-0001")
+      expect(JSON.parse(zargIn(root, "affected").out)).toMatchObject({ cards: [], removed: [] })
+    } finally {
+      rmSync(root, { recursive: true, force: true })
+    }
+  })
+})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/cli && mise x -- bun test test/cli.test.ts -t affected`
Expected: FAIL (`affected` is not a command; stdout is not JSON).

- [ ] **Step 3: Implement the commands**

Apply (the CLI depends on `@zarg/reconcile`; then run `mise x -- bun install`):

```diff
--- a/packages/cli/src/commands.ts
+++ b/packages/cli/src/commands.ts
@@ -2,7 +2,11 @@
 import { Argument, Command, Flag } from "effect/unstable/cli"
 import { diff, GraphStore, hash, Snapshot } from "@zarg/graph"
 import { PluginHost } from "@zarg/plugin/server"
+import { rmSync, writeFileSync } from "node:fs"
+import { join } from "node:path"
 import { readClaim, startHeadless, stopCore } from "@zarg/client"
+import { affectedCards } from "@zarg/plugin-gherkin/server"
+import { baseTree, CHECKPOINT, LEGACY_CHECKPOINT, snapshotAtTree, workingGraphTree } from "@zarg/reconcile"
 import { cardRefs, snapshotAt } from "./git"
 import { root } from "./root"
 
@@ -87,6 +91,28 @@
   }),
 )
 
+// @card UX-0020
+const affected = Command.make("affected", {}, () =>
+  Effect.gen(function* () {
+    const base = yield* baseTree(root)
+    const graph = yield* workingGraphTree(root)
+    const [before, after] = yield* Effect.all([snapshotAtTree(root, base), snapshotAtTree(root, graph)])
+    yield* print({ base, graph, ...affectedCards(before, after) })
+  }),
+)
+
+// @card UX-0022
+const checkpoint = Command.make("checkpoint", {}, () =>
+  Effect.gen(function* () {
+    const graph = yield* workingGraphTree(root)
+    yield* Effect.sync(() => {
+      writeFileSync(join(root, CHECKPOINT), `${JSON.stringify({ graph }, null, 2)}\n`)
+      rmSync(join(root, LEGACY_CHECKPOINT), { force: true })
+    })
+    yield* print({ graph })
+  }),
+)
+
 const coreStart = Command.make(
   "start",
   { headless: Flag.Boolean("headless").pipe(Flag.withDescription("run until `zarg core stop`, detached from this terminal")) },
@@ -117,4 +143,4 @@
     focus: Flag.String("focus").pipe(Flag.atLeast(0), Flag.withDescription("graph node the thread focuses on (repeatable)")),
   },
   ({ thread, focus }) => Effect.flatMap(Effect.promise(() => import("./tui/run")), (m) => m.runTui({ root, threadId: thread, focus })),
-).pipe(Command.withSubcommands([tool, show, render, agenda, lint, query, diffCmd, core]))
+).pipe(Command.withSubcommands([tool, show, render, agenda, lint, query, diffCmd, affected, checkpoint, core]))
--- a/packages/cli/package.json
+++ b/packages/cli/package.json
@@ -9,6 +9,7 @@
     "@zarg/graph": "workspace:*",
     "@zarg/plugin": "workspace:*",
     "@zarg/plugin-gherkin": "workspace:*",
+    "@zarg/reconcile": "workspace:*",
     "effect": "^4.0.0-rc.117",
     "react": "19"
   },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `mise x -- bun install && cd packages/cli && mise x -- bunx tsc -p . && mise x -- bun test`
Expected: PASS (37 tests).

- [ ] **Step 5: The skill, config, docs and the smoke test**

Delete the old skill: `git rm -r .claude/skills/zarg-sync`.

`.claude/skills/zarg-implement/SKILL.md`:

````md
---
name: zarg-implement
description: Act as zarg's planner and implementer - make the code match the requirements graph (.zarg/graph) the way a reconcile pass does - plan each changed card, implement it, verify, and commit cards, plans, code and checkpoint together. Use when the user asks to implement, reconcile or sync the graph into code without a running zarg core.
---

# zarg-implement

You are the planner and the implementer: you make the code match the requirements graph under `.zarg/graph`, exactly as zarg's plan and implement phases do. You never change requirements; the `zarg-drive` skill does that. (When a zarg core is running, it reconciles on its own; use this skill when none is.)

Run the CLI from the repo root as `mise run -q zarg -- <command>`.

## Steps

1. Find the work: `mise run -q zarg -- affected`. It prints `cards` (added, changed, or using a reworded state) and `removed`. If both are empty, report "in sync" and stop.
2. For each removed card, delete `.zarg/plans/<id>.md`.
3. Plan each card in `cards`:
   - Read it: `render --focus <id> --k 1`, and `show <id>` for its `hash`.
   - Read the code it touches (`query code <id>` finds existing `// @card` tags).
   - Write `.zarg/plans/<id>.md`:

     ```md
     # <id> <card title>
     card: <hash from show>

     ## Approach
     ## Files
     - path — what changes
     ## Tests
     - test name — what it proves
     ## Depends on
     - <card ids, or none>
     ```
   - If the card contradicts another card or cannot be implemented as written, do not guess and do not edit the graph: stop and tell the user which card and why, and suggest running `zarg-drive` on it.
4. Implement each plan test-first. Tag the implementation and its tests with `// @card <id>`. Never edit `.zarg/graph` or another card's plan.
5. Run `mise run verify`. It must pass; fix what fails (at most two attempts before you stop and report).
6. Record the checkpoint: `mise run -q zarg -- checkpoint` (writes `.zarg/reconciled.json` with the graph you implemented; it also retires a legacy `.zarg/sync.json`).
7. Commit the cards, plans, code and checkpoint together: `git add .zarg/graph .zarg/plans .zarg/reconciled.json <code paths> && git commit -m "feat: implement <card ids>"`.
````

`packages/cli/smoke/implement.ts` (the live smoke test; **do not run it without asking the developer**):

```ts
// Live smoke test (outside `mise run verify`): one real card through plan and implement. It runs in a scratch
// clone of this repo (your checkout is never touched): a core starts there, a small card is added to the graph,
// and the run passes when a pass lands "feat: implement <card>" (or fails with the findings it raised).
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { connect } from "@zarg/client"
import { coreCommand } from "../src/tui/run"

const repo = resolve(process.env.ZARG_ROOT ?? process.cwd())
const TIMEOUT_MS = 20 * 60_000
const cli = join(repo, "packages/cli/src/main.ts")
const run = (cwd: string, argv: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const p = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...env } })
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

const scratch = mkdtempSync(join(tmpdir(), "zarg-smoke-implement-"))
run(tmpdir(), ["git", "clone", "-q", "--no-hardlinks", repo, scratch])
run(scratch, ["mise", "trust", "-q"])
console.log(`scratch ${scratch}`)

const conn = await Effect.runPromise(connect({ root: scratch, command: coreCommand() }))
console.log(`core ${conn.info.mode} (pid ${conn.info.pid}), driver model ${conn.info.driver ?? "?"}`)
const added = JSON.parse(
  run(scratch, [process.execPath, cli, "tool", "call", "gherkin/add-card", JSON.stringify({ title: "Agent reads the zarg version", when: "the agent runs zarg version", arrives: { id: "S-0001" }, then: [{ text: "the zarg version is printed" }] })], { ZARG_ROOT: scratch }),
) as { added: ReadonlyArray<string> }
const card = added.added.find((id) => id.startsWith("UX-"))!
console.log(`added ${card}; waiting for plan and implement (up to ${TIMEOUT_MS / 60_000} min)`)

const findingsFile = join(scratch, ".zarg/reconcile/findings.json")
const findings = () => (existsSync(findingsFile) ? (JSON.parse(readFileSync(findingsFile, "utf8")) as ReadonlyArray<{ kind: string; title: string; detail: string }>) : [])
const deadline = Date.now() + TIMEOUT_MS
let verdict: { ok: boolean; why: string } | undefined
while (verdict === undefined) {
  const subject = run(scratch, ["git", "log", "-1", "--format=%s"])
  if (subject.includes(card)) verdict = { ok: true, why: `landed: ${subject} (${run(scratch, ["git", "rev-parse", "--short", "HEAD"])})` }
  else if (findings().length > 0) verdict = { ok: false, why: findings().map((f) => `${f.kind}: ${f.title} — ${f.detail.slice(0, 300)}`).join("\n") }
  else if (Date.now() > deadline) verdict = { ok: false, why: "no pass landed in time" }
  else await Bun.sleep(5000)
}
await conn.close()
if (verdict.ok) console.log(run(scratch, ["git", "show", "--stat", "--format=%s", "HEAD"]))
console.log(`transcripts ${join(scratch, ".zarg/threads")}/{plan,implement}.rlm.jsonl`)
console.log(verdict.ok ? `PASS: ${verdict.why}` : `FAIL: ${verdict.why}`)
process.exit(verdict.ok ? 0 : 1)
```

Apply the task, config and doc changes (`smoke:implement` in `mise.toml`; roles `plan` and `implement` plus `[reconcile]` in this repo's `.zarg/config.toml`; `AGENTS.md`; the architecture spec's sync wording; the drive skill's pointer):

```diff
--- a/mise.toml
+++ b/mise.toml
@@ -19,6 +19,10 @@
 description = "Live chat smoke test: one real driver item through core and the client (needs the configured driver model)"
 run = "mise x -- bun packages/cli/smoke/chat.ts"
 
+[tasks."smoke:implement"]
+description = "Live implement smoke test: one real card through plan and implement, in a scratch clone (needs the configured plan and implement models)"
+run = "mise x -- bun packages/cli/smoke/implement.ts"
+
 [tasks.smoke]
 description = "Live smoke test: one real research RLM on this repo (needs the configured model providers)"
 run = "mise x -- bun packages/rlm/smoke/smoke.ts"
--- a/.zarg/config.toml
+++ b/.zarg/config.toml
@@ -8,6 +8,12 @@
 api_key  = "${OPENROUTER_API_KEY:-}"
 
 [roles]
-driver   = "zarg-router:deepseek-v4.1-flash-exl3"
-sync     = "zarg-router:deepseek-v4.1-flash-exl3"
-decision = "zarg-router:jevk5"
+driver    = "zarg-router:deepseek-v4.1-flash-exl3"
+plan      = "zarg-router:deepseek-v4.1-flash-exl3"
+implement = "zarg-router:deepseek-v4.1-flash-exl3"
+decision  = "zarg-router:jevk5"
+
+# Plan and implement (the reconcile loop): passes run while a core runs; `enabled = false` turns them off.
+[reconcile]
+setup  = "mise trust -q && mise x -- bun install"
+verify = "mise run verify"
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -34,7 +34,7 @@
 - `packages/decisions` (`@zarg/decisions`): `Decisions` service (JEV `/systemone`, structured fallback).
 - `packages/kernel` (`@zarg/kernel`): yieldable service definitions, the manifest they generate, and the Bun Worker kernel that typechecks and runs cells.
 - `packages/rlm` (`@zarg/rlm`): the RLM (unit of agency): presets and spawn graph, scoped core services (`Graph`, `Fs`, `Sh`, `Verify`, `Agenda`, `Inquire`), plugin tools as services, and the turn loop.
-- `packages/core` (`@zarg/core`): `zarg-core`, one per project: driver threads on RLMs, the AG-UI API on `.zarg/run/core.sock` (token in `.zarg/run/core.json`), thread logs in `.zarg/threads/`.
+- `packages/core` (`@zarg/core`): `zarg-core`, one per project: driver threads on RLMs, the plan and implement phases on the reconcile loop (`plan` and `implement` threads, findings on the driver's agenda), the AG-UI API on `.zarg/run/core.sock` (token in `.zarg/run/core.json`), thread logs in `.zarg/threads/`.
 - `packages/client` (`@zarg/client`): attach to or start a core, the AG-UI client, and `reduce` (events → thread state). Never imports `@zarg/core` or a `/server` subpath.
 - `packages/reconcile` (`@zarg/reconcile`): the reconcile loop every downstream phase runs (see `intent/zarg.md`): affected cards, per-card git worktrees, merge, verify with fixes, one commit per pass landed on your branch, findings; each pass is a durable Effect workflow (`.zarg/run/cluster.db`).
 
@@ -50,7 +50,7 @@
 This repo's requirements live in its own zarg graph under `.zarg/graph`.
 
 - Use the `zarg-drive` skill (`.claude/skills/zarg-drive/SKILL.md`) to refine requirements. It edits only the graph.
-- Use the `zarg-sync` skill (`.claude/skills/zarg-sync/SKILL.md`) to make code match the graph. It edits only code.
+- Use the `zarg-implement` skill (`.claude/skills/zarg-implement/SKILL.md`) to make code match the graph when no zarg core is running (a running core plans and implements on its own). It edits only code and `.zarg/plans`.
 - Never edit `.zarg/graph` files by hand. Change them through `zarg tool call`.
 - Tag code that implements a card with a `// @card <id>` comment (for example `// @card UX-0003`).
 
--- a/docs/superpowers/specs/2026-09-25-harness-architecture-design.md
+++ b/docs/superpowers/specs/2026-09-25-harness-architecture-design.md
@@ -5,7 +5,7 @@
 
 ## Intent
 
-zarg is a coding-agent harness. You converse with a driver agent to continuously refine product requirements. The requirements live as an atomic Gherkin user action graph. As a side effect, a continuous sync agent reconciles graph changes into implementation code, like a virtual DOM whose output is generated code instead of DOM patches.
+zarg is a coding-agent harness. You converse with a driver agent to continuously refine product requirements. The requirements live as an atomic Gherkin user action graph. As a side effect, downstream phases (plan, implement) reconcile graph changes into implementation code, like a virtual DOM whose output is generated code instead of DOM patches. The pipeline is set out in `intent/zarg.md`.
 
 Success means: you refine requirements in conversation, and code converges to match without you asking "implement X". The first proof point is Claude Code building zarg through zarg's own graph.
 
@@ -212,7 +212,7 @@
 | Thread | Count | Agent | Scope |
 |---|---|---|---|
 | driver threads | 1..N per project; `main` always exists | driver agent | its focus |
-| `sync` | 1 per project | sync agent | all commits |
+| `plan`, `implement` | 1 each per project | planner, implementer (reconcile passes) | all graph changes |
 
 - Each driver thread has a focus: a subgraph such as "cards reachable from S-0002". The agent proposes the focus by inquiry when you open a thread. Agenda items outside every focus go to `main`.
 - A thread is told about other threads' commits inside its focus.
@@ -237,11 +237,9 @@
 - You can interject any time. Your message cancels the pending inquiry and is considered before the next item.
 - The driver changes the graph only. It never edits code.
 
-### Sync agent
+### Plan and implement (formerly the sync agent)
 
-- Subscribes to commits, debounced (about 2 seconds of quiet), and dispatches the diff to plugin reactors.
-- Changes code only. It never edits requirements. A requirement it cannot satisfy becomes an agenda finding for a driver thread.
-- What the sync agent owns in code (tagged regions, fully generated output, or a hybrid) is decided in its own spec.
+Superseded by `intent/zarg.md` and `docs/superpowers/specs/2026-09-26-plan-implement-design.md`: downstream work is a pipeline of phases (capture, specify, rehearse, plan, implement), each run by the same reconcile loop. Plan and implement run after the graph is quiet, per card in git worktrees, and land one commit per pass. They change plans and code only, never requirements; what they cannot do becomes a finding on the driver's agenda. What implement owns in code (tagged regions, generated output, or a hybrid) is still its own spec.
 
 ### Conflicts
 
--- a/.claude/skills/zarg-drive/SKILL.md
+++ b/.claude/skills/zarg-drive/SKILL.md
@@ -5,7 +5,7 @@
 
 # zarg-drive
 
-You are the driver. You lead the conversation about what the product should do, and you record every decision in the requirements graph under `.zarg/graph`. You never edit code; the `zarg-sync` skill does that.
+You are the driver. You lead the conversation about what the product should do, and you record every decision in the requirements graph under `.zarg/graph`. You never edit code; the plan and implement phases (or the `zarg-implement` skill) do that.
 
 Run the CLI from the repo root as `mise run -q zarg -- <command>`. Output is JSON on stdout. Failures are JSON on stderr with exit code 1.
 
```

Run: `cd packages/cli && mise x -- bunx tsc -p .` then `mise run verify`
Expected: no type errors (the smoke script is typechecked); verify passes.

- [ ] **Step 6: Commit**

```bash
git add packages/cli bun.lock mise.toml .zarg/config.toml AGENTS.md docs .claude
git commit -m "feat(cli): zarg affected and checkpoint; zarg-implement skill; smoke:implement; sync retired in docs"
```
