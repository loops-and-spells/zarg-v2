# The Shell (bar, sheet, popovers, input layers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The TUI becomes the approved shell: the agents list full height on the left, the open agent's view in the tile area, zarg as a one-line message bar that opens into a sheet over the tile area, grant questions as a FIFO popover queue, attention that pulses until seen, Alt+letter hotkeys, and every key routed through input layers.

**Architecture:** `@zarg/view` gains the platform-free input mechanism (`input.ts`) and per-platform action keys with reserved-key checks. The core stops asking grants through zarg's thread: a `Prompts` queue emits `zarg.prompt` / `zarg.prompt.done` custom events and answers `POST /prompts/:id`. The client folds prompts into thread state for every client. `@zarg/view-tui` replaces its `onKey` with layers dispatched top-down and rebuilds `App` around the new layout.

**Tech Stack:** Bun (`mise x -- bun`), TypeScript, Effect 4, React 19, opentui 0.5.12.

**Spec:** `docs/superpowers/specs/2026-09-27-shell-sheet-design.md` (with `docs/superpowers/specs/2026-09-27-input-layers-design.md` for the layer model and agents' key mappings).

**This is plan 1 of 2.** Plan 2 (surfaces: `tile | panel | popover | sheet` declared by plugins, instances, `opens`, gestures, zarg's sheet and bar declared by agent-zarg) follows once this lands. In this plan the shell draws zarg's sheet and bar itself, from `zargConversation` as today, and the grant popover is the shell's own.

## Global Constraints

- `mise run verify` must pass before every commit; run tools through `mise x -- bun …`; tests spawn `process.execPath`.
- `@zarg/view`'s `.` export imports only `effect` (the existing portability test).
- `@zarg/view-tui` and `@zarg/client` never import `@zarg/core` or a `/server` subpath (existing boundary tests).
- Global keys, a closed list: Ctrl-C (stop; twice within 2 s exits), Ctrl-D (exit), Alt+←→↑↓, `alt+a` `alt+v` `alt+m`.
- Terminal reserved keys (agents may not map them): Ctrl-*, Alt-*, arrows, Tab, Shift-Tab, Enter, Esc, Space, PgUp, PgDn, `[`, `]`, `g`, `x`, `/`.
- Agents list 30 columns, full height; narrow is under 100 columns.
- Attention blinks every 500 ms until the developer opened the agent since its request.
- YOLO never asks: no grant popover under YOLO (unchanged core behaviour).
- Never print, log or commit a secret; never start a core or the TUI in the repo root; no live models; tests never write to `~/.config/zarg`.

## Review Focus

1. Typing `g`, `x`, `/`, `[`, space or an agent's action letter in the message bar: every character lands in the bar, nothing else fires. → Task 4, test "the bar owns printable keys while typing".
2. A grant arriving while the developer types in the bar: the popover takes the keys at once, the bar's input is blurred (no characters leak into it), and after answering the typing resumes where it was. → Task 5, test "a grant popover blurs the bar; answering it gives the bar back".
3. Two clients on one core: a grant answered in one leaves the other's queue. → Task 3, test "a prompt answered anywhere leaves every client's queue".
4. The core restarts with a grant open: the new core withdraws it, no popover lingers. → Task 2, test "a restarted core withdraws prompts the last one left open".
5. Esc or any other key on a grant: it stays up with the keys, and the next popover never jumps ahead of it. → Task 4, test "the queue is strictly first in, first out: Esc never reorders it".

---

### Task 1: The input mechanism (`@zarg/view/src/input.ts`)

**Files:**
- Create: `packages/view/src/input.ts`
- Modify: `packages/view/src/index.ts` (add `export * from "./input"`)
- Test: `packages/view/test/input.test.ts`

**Interfaces — Produces:**
```ts
export interface InputKey { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean }
export interface KeyHint { readonly keys: string; readonly does: string }
export type Handled<U, A> = { readonly ui: U; readonly action?: A; readonly draft?: string }
export interface InputLayer<U, W, A> {
  readonly id: string
  readonly when: (ui: U, world: W) => boolean
  readonly hints: (ui: U, world: W) => ReadonlyArray<KeyHint>
  readonly handle: (ui: U, world: W, key: InputKey) => Handled<U, A> | "pass"
}
export const stackOf: <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W) => ReadonlyArray<InputLayer<U, W, A>>
export const dispatch: <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, key: InputKey) => Handled<U, A> & { readonly by?: string }
export const hintsOf: <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, limit?: number) => ReadonlyArray<KeyHint>
export const printable: (key: InputKey) => boolean
```

- [ ] **Step 1: Write the failing test** (`packages/view/test/input.test.ts`)

```ts
import { describe, expect, test } from "bun:test"
import { dispatch, hintsOf, type InputLayer, printable } from "../src/input"

type U = { readonly n: number }
const layer = (id: string, owns: (k: string) => boolean, on = true): InputLayer<U, { on: boolean }, string> => ({
  id,
  when: (_u, w) => (id === "bottom" ? w.on : on),
  hints: () => [{ keys: id, does: `${id} things` }],
  handle: (u, _w, k) => (owns(k.name) ? { ui: { n: u.n + 1 }, action: `${id}:${k.name}` } : "pass"),
})
const layers = [layer("global", (k) => k === "q"), layer("top", (k) => k === "x"), layer("mid", (k) => k === "up"), layer("bottom", () => true)]

describe("input layers", () => {
  test("a key goes to the first layer on the stack that owns it", () => {
    expect(dispatch(layers, { n: 0 }, { on: true }, { name: "x" })).toEqual({ ui: { n: 1 }, action: "top:x", by: "top" })
    expect(dispatch(layers, { n: 0 }, { on: true }, { name: "up" }).by).toBe("mid")
    expect(dispatch(layers, { n: 0 }, { on: true }, { name: "z" }).by).toBe("bottom")
  })
  test("a key no layer owns does nothing", () => {
    expect(dispatch(layers, { n: 0 }, { on: false }, { name: "z" })).toEqual({ ui: { n: 0 } })
  })
  test("hints come from the top layers below global", () => {
    expect(hintsOf(layers, { n: 0 }, { on: true }).map((h) => h.keys)).toEqual(["top", "mid"])
  })
  test("printable: one character, space or Backspace, without Ctrl or Alt", () => {
    expect([{ name: "a" }, { name: "space" }, { name: "backspace" }, { name: "/" }].every(printable)).toBe(true)
    expect([{ name: "up" }, { name: "a", ctrl: true }, { name: "a", meta: true }, { name: "return" }].some(printable)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it** — `mise //packages/view:test` — Expected: FAIL, cannot find module `../src/input`.

- [ ] **Step 3: Write `packages/view/src/input.ts`**

```ts
/** A key as any platform reports it. */
export interface InputKey { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean }
/** One line of a hint: the keys and what they do. */
export interface KeyHint { readonly keys: string; readonly does: string }
export type Handled<U, A> = { readonly ui: U; readonly action?: A; readonly draft?: string }

/** One owner of keys. Layers are derived from state (`when`), never pushed: close the thing and its layer is gone. */
export interface InputLayer<U, W, A> {
  readonly id: string
  readonly when: (ui: U, world: W) => boolean
  readonly hints: (ui: U, world: W) => ReadonlyArray<KeyHint>
  /** Handle the key, or pass it down. */
  readonly handle: (ui: U, world: W, key: InputKey) => Handled<U, A> | "pass"
}

/** The layers on the stack now, top first (`layers` is given top first). */
export const stackOf = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W) => layers.filter((l) => l.when(ui, world))

/** The key goes to the top layer; each handles it or passes it down; a key no layer owns does nothing. */
export const dispatch = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, key: InputKey): Handled<U, A> & { readonly by?: string } => {
  for (const l of stackOf(layers, ui, world)) {
    const r = l.handle(ui, world, key)
    if (r !== "pass") return { ...r, by: l.id }
  }
  return { ui }
}

/** What the status line shows: the hints of the top `limit` layers below the global one. */
export const hintsOf = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, limit = 2): ReadonlyArray<KeyHint> =>
  stackOf(layers, ui, world)
    .filter((l) => l.id !== "global")
    .slice(0, limit)
    .flatMap((l) => l.hints(ui, world))

/** A key a text input takes as text: one character, space or Backspace, without Ctrl or Alt. */
export const printable = (key: InputKey) => key.ctrl !== true && key.meta !== true && (key.name.length === 1 || key.name === "space" || key.name === "backspace")
```

- [ ] **Step 4: Run** — `mise //packages/view:test` — Expected: PASS (portability test included).
- [ ] **Step 5: Commit** — `mise run verify`, then `git add packages/view && git commit -m "feat(view): input layers: a stack derived from state, dispatched top-down"`.

---

### Task 2: Grants leave zarg's conversation: the core's prompt queue

**Files:**
- Create: `packages/core/src/prompts.ts`
- Modify: `packages/core/src/live.ts` (make prompts, `closeStale` them at start, `control.setAsk` and `outsideReads` ask through them, return `prompts`), `packages/core/src/server.ts` (service `Prompts`, route `POST /prompts/:id`), `packages/core/src/main.ts` (provide `Prompts`), `packages/agent-host/src/index.ts` (`outsideReads: unknown`), `packages/agent-zarg/src/zarg.ts` (line 40: `const outside = host.outsideReads as never`)
- Test: `packages/core/test/prompts.test.ts`

**Interfaces — Produces:**
```ts
// packages/core/src/prompts.ts
export const PROMPT = "zarg.prompt"          // CUSTOM value: { id, question, options, kind: "grant" }
export const PROMPT_DONE = "zarg.prompt.done" // CUSTOM value: { id, withdrawn?: true }
export const makePrompts: (log: ThreadLog, threadId?: string) => {
  readonly ask: (q: Question) => Effect.Effect<Answer>
  readonly answer: (id: string, answer: { readonly choice: string }) => Effect.Effect<{ readonly notice: string }>
  readonly closeStale: Effect.Effect<void>
}
// server.ts
export class Prompts extends Context.Service<Prompts, { readonly answer: (id: string, answer: { readonly choice: string }) => Effect.Effect<{ readonly notice: string }> }>()("@zarg/core/Prompts") {}
```
`Question` and `Answer` are `@zarg/rlm`'s (`import type { Answer, Question } from "@zarg/rlm"`).

- [ ] **Step 1: Write the failing test** (`packages/core/test/prompts.test.ts`)

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { makeLog } from "../src/log"
import { makePrompts, PROMPT, PROMPT_DONE } from "../src/prompts"

const q = { question: "Plugin tracker wants to reach a.test.", options: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }], allowOther: false, kind: "grant" as const }
const open = () => Effect.runPromise(makeLog(mkdtempSync(join(tmpdir(), "zarg-prompts-")), (t) => t))
const customs = (log: Awaited<ReturnType<typeof open>>) => log.all().filter((e) => e.type === "CUSTOM").map((e) => ({ name: e.name, value: e.value as Record<string, unknown> }))

describe("prompts", () => {
  test("two prompts wait side by side; each is answered by its id, in any order", async () => {
    const log = await open()
    const p = makePrompts(log)
    const a = Effect.runFork(p.ask(q))
    const b = Effect.runFork(p.ask({ ...q, question: "Plugin tracker wants to reach b.test." }))
    await Bun.sleep(10)
    const [ida, idb] = customs(log).filter((c) => c.name === PROMPT).map((c) => String(c.value.id))
    expect(await Effect.runPromise(p.answer(idb!, { choice: "deny" }))).toEqual({ notice: "answered" })
    expect(await Effect.runPromise(Fiber.join(b))).toEqual({ choice: "deny" })
    await Effect.runPromise(p.answer(ida!, { choice: "once" }))
    expect(await Effect.runPromise(Fiber.join(a))).toEqual({ choice: "once" })
    expect(customs(log).filter((c) => c.name === PROMPT_DONE).map((c) => c.value.id)).toEqual([idb, ida])
  })
  test("an answer to a prompt no one waits for says so", async () => {
    const p = makePrompts(await open())
    expect(await Effect.runPromise(p.answer("prompt-nope", { choice: "once" }))).toEqual({ notice: "that question is no longer open" })
  })
  test("an asker that goes away withdraws its prompt", async () => {
    const log = await open()
    const f = Effect.runFork(makePrompts(log).ask(q))
    await Bun.sleep(10)
    await Effect.runPromise(Fiber.interrupt(f))
    expect(customs(log).at(-1)).toMatchObject({ name: PROMPT_DONE, value: { withdrawn: true } })
  })
  test("a restarted core withdraws prompts the last one left open", async () => {
    const log = await open()
    Effect.runFork(makePrompts(log).ask(q))
    await Bun.sleep(10)
    await Effect.runPromise(makePrompts(log).closeStale)
    const id = customs(log).find((c) => c.name === PROMPT)!.value.id
    expect(customs(log).at(-1)).toEqual({ name: PROMPT_DONE, value: { id, withdrawn: true } })
  })
})
```

- [ ] **Step 2: Run** — `mise //packages/core:test -- prompts` — Expected: FAIL, cannot find `../src/prompts`.

- [ ] **Step 3: Write `packages/core/src/prompts.ts`**

```ts
import { Deferred, Effect } from "effect"
import type { Answer, Question } from "@zarg/rlm"
import * as E from "./events"
import type { ThreadLog } from "./log"

export const PROMPT = "zarg.prompt"
export const PROMPT_DONE = "zarg.prompt.done"

/**
 * Questions the core asks the developer itself (grants): they wait side by side, never behind zarg's own question,
 * and every client shows them as popovers, first in first out. Each is answered by its id.
 */
export const makePrompts = (log: ThreadLog, threadId = "main") => {
  const open = new Map<string, Deferred.Deferred<Answer>>()
  const done = (id: string, withdrawn: boolean) => log.append(threadId, E.custom(PROMPT_DONE, withdrawn ? { id, withdrawn: true } : { id }))
  return {
    ask: (q: Question): Effect.Effect<Answer> =>
      Effect.gen(function* () {
        const id = `prompt-${crypto.randomUUID()}`
        const answer = yield* Deferred.make<Answer>()
        open.set(id, answer)
        yield* log.append(threadId, E.custom(PROMPT, { id, question: q.question, options: q.options, kind: "grant" }))
        // An asker that goes away (its plugin stopped, the core shutting down) takes its prompt off every screen.
        return yield* Deferred.await(answer).pipe(Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => open.delete(id)), Effect.ignore(done(id, true)))))
      }),
    answer: (id: string, a: { readonly choice: string }) =>
      Effect.gen(function* () {
        const waiting = open.get(id)
        if (waiting === undefined) return { notice: "that question is no longer open" }
        open.delete(id)
        yield* Effect.ignore(done(id, false))
        yield* Deferred.succeed(waiting, { choice: a.choice })
        return { notice: "answered" }
      }),
    /** Prompts the last core left open have no one waiting: withdraw them. */
    closeStale: Effect.suspend(() => {
      const asked = new Set<string>()
      for (const e of log.all()) {
        if (e.type !== "CUSTOM") continue
        const id = String((e.value as { id?: unknown } | undefined)?.id)
        if (e.name === PROMPT) asked.add(id)
        if (e.name === PROMPT_DONE) asked.delete(id)
      }
      return Effect.forEach([...asked].filter((id) => !open.has(id)), (id) => Effect.ignore(done(id, true)), { discard: true })
    }),
  }
}
export type PromptQueue = ReturnType<typeof makePrompts>
```

- [ ] **Step 4: Run** — `mise //packages/core:test -- prompts` — Expected: PASS.

- [ ] **Step 5: Wire it into the core**

In `packages/core/src/live.ts`, right after `yield* closeStale(log)`:
```ts
    // Grants are the core's own questions: popovers on every client, never in zarg's conversation.
    const prompts = makePrompts(log)
    yield* prompts.closeStale
```
Replace the `outsideReads` member of `agentHost`:
```ts
      outsideReads: outsideReads({ grants: agentGrants, userDir: USER_DIR, ask: prompts.ask as never, yolo: () => yoloControl.on("zarg:agents") }),
```
Replace the `control.setAsk((q) => main.ask({...}))` block with:
```ts
    control.setAsk((q) =>
      prompts
        .ask({ question: `Plugin ${q.plugin} wants to ${q.what}.`, options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.id === "once" ? { recommended: true } : {}) })), allowOther: false, kind: "grant" })
        .pipe(Effect.map((a) => q.options.find((o) => o.id === a.choice)?.id ?? "deny")),
    )
```
Return `prompts` from `liveCore` (`return { log, threads, driver: roles.driver, turnOn, yolo, actions, commands, prompts }`).

In `packages/agent-host/src/index.ts`: `readonly outsideReads: unknown` with doc "The gate for reads outside the repository (the core asks the developer itself)." In `packages/agent-zarg/src/zarg.ts` line 40: `const outside = host.outsideReads as never`.

In `packages/core/src/server.ts` add the `Prompts` service above, `const prompts = yield* Prompts` in `routes`, and the route (plus a line in the API doc comment `POST /prompts/:id  { choice } → { notice }`):
```ts
      HttpRouter.route(
        "POST",
        "/prompts/:id",
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.params
          const body = (yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => ({})))) as { choice?: unknown }
          if (typeof body.choice !== "string") return error(400, `an answer needs { "choice" }`)
          return HttpServerResponse.jsonUnsafe(yield* prompts.answer(decodeURIComponent(id ?? ""), { choice: body.choice }))
        }),
      ),
```
In `packages/core/src/main.ts` add `Layer.succeed(Prompts, core.prompts)` to the provided layers (import `Prompts` from `./server`).

`Thread.ask` stays in `@zarg/agent-host` and agent-zarg (its tests use it); nothing in the core calls it any more (ledger this as a ruling; plan 2 removes it with the rest of zarg's question plumbing).

- [ ] **Step 6: Run** — `mise run verify` — Expected: PASS. If `packages/cli/test/tui.e2e.test.tsx` fails on "Plugin rehearse wants to load", that is expected until Task 8: mark it `test.skip` with the comment `// Task 8 moves the grant into the popover` and ledger it.
- [ ] **Step 7: Commit** — `git commit -m "feat(core): grants are the core's own prompts, answered by id"`.

---

### Task 3: Prompts in the client

**Files:**
- Modify: `packages/client/src/state.ts` (`Prompt`, `ThreadState.prompts`, reduce), `packages/client/src/client.ts` (`answerPrompt`), `packages/client/src/session.ts` (`answerPrompt`), `packages/view-tui/test/app.test.tsx` (the fake session gains `answerPrompt`)
- Test: `packages/client/test/state.test.ts`, `packages/client/test/session.test.ts` (if it builds a fake client, add `answerPrompt` there)

**Interfaces — Produces:**
```ts
// state.ts
export interface Prompt { readonly id: string; readonly question: string; readonly options: ReadonlyArray<Option>; readonly kind: "grant" }
// ThreadState gains:
readonly prompts?: ReadonlyArray<Prompt>
// client.ts
answerPrompt: (id: string, choice: string) => Effect.Effect<{ readonly notice: string }, CoreError>
// session.ts, Session gains:
readonly answerPrompt: (id: string, choice: string) => Promise<void>
```

- [ ] **Step 1: Write the failing test** (append to `packages/client/test/state.test.ts`)

```ts
describe("prompts", () => {
  const asked = (id: string, threadId = "main") => ev("CUSTOM", { name: "zarg.prompt", value: { id, question: `q ${id}`, options: [{ id: "once", label: "Allow once" }], kind: "grant" } }, threadId)
  test("prompts queue in the order asked; done takes one out", () => {
    const s = fold([asked("p1"), asked("p2"), ev("CUSTOM", { name: "zarg.prompt.done", value: { id: "p1" } })])
    expect(s.prompts?.map((p) => p.id)).toEqual(["p2"])
  })
  test("a prompt answered anywhere leaves every client's queue, whatever thread the client follows", () => {
    const s = fold([asked("p1"), ev("CUSTOM", { name: "zarg.prompt.done", value: { id: "p1", withdrawn: true } })], initial("other"))
    expect(s.prompts ?? []).toEqual([])
    expect(fold([asked("p1")], initial("other")).prompts?.map((p) => p.id)).toEqual(["p1"])
  })
  test("a replayed prompt is not queued twice", () => {
    const e = asked("p1")
    expect([e, e].reduce(reduce, initial("main")).prompts).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run** — `mise //packages/client:test -- state` — Expected: FAIL (`prompts` undefined).

- [ ] **Step 3: Implement.** In `state.ts`, add the `Prompt` interface and `prompts` field, then at the top of `reduce` (before the thread check, since prompts are the core's, not a thread's):
```ts
  // Prompts are the core's own questions: every client queues them, whatever thread it follows.
  if (e.type === "CUSTOM" && (e.name === "zarg.prompt" || e.name === "zarg.prompt.done") && e.seq > s.seq) {
    const v = e.value as { id?: unknown; question?: unknown; options?: ReadonlyArray<Option> }
    const id = String(v.id)
    const rest = (s.prompts ?? []).filter((p) => p.id !== id)
    const prompts = e.name === "zarg.prompt" ? [...rest, { id, question: String(v.question ?? ""), options: v.options ?? [], kind: "grant" as const }] : rest
    return { ...s, seq: e.seq, prompts }
  }
```
In `client.ts`:
```ts
    /** Answer one of the core's prompts (a grant). */
    answerPrompt: (id: string, choice: string) =>
      request(`/prompts/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ choice }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly notice: string }>)),
      ),
```
In `session.ts`, the `Session` member (doc: "Answer one of the core's prompts (a grant popover); its notice shows.") and:
```ts
    answerPrompt: (id, choice) =>
      Effect.runPromise(
        opts.client.answerPrompt(id, choice).pipe(
          Effect.map((r) => r.notice),
          Effect.catch((e) => Effect.succeed(e.message)),
          Effect.flatMap((notice) => Effect.sync(() => set({ ...state, notice }))),
        ),
      ),
```
In `packages/view-tui/test/app.test.tsx`'s `fakeSession`: `answerPrompt: (id, choice) => Promise.resolve(void calls.push(\`prompt ${id} ${choice}\`)),`.

- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): the core's prompts queue for every client"`.

---

### Task 4: The shell's state and input layers

**Files:**
- Create: `packages/view-tui/src/layers.ts`
- Modify: `packages/view-tui/src/view.ts` (the `Ui` shape, helpers, `onKey` becomes `dispatch(SHELL, …)`, `onSubmit`, `Action`)
- Test: `packages/view-tui/test/layers.test.ts`; migrate `packages/view-tui/test/view.test.ts`

**Interfaces — Consumes:** Task 1 (`InputLayer`, `dispatch`, `hintsOf`, `printable`), Task 3 (`ThreadState.prompts`, `Prompt`).

**Interfaces — Produces** (`view.ts`, all exported):
```ts
export type Focus = "agents" | "tile" | "bar"
export interface Ui {
  readonly focus: Focus
  /** zarg's sheet covers the tile area (it also shows while no agent is open). */
  readonly sheet: boolean
  readonly pick: number; readonly inquiryId?: string; readonly other: boolean; readonly chatting?: string; readonly answered?: string
  readonly slash?: { readonly sel: number | null; readonly cycle: SlashCycle | null }
  readonly lastCtrlC?: number; readonly runningSince?: number
  readonly agents: Agents; readonly viewing?: string; readonly view?: ViewUi; readonly attentionAt?: string
  /** The popover queue's head (the core keeps the queue, strictly first in first out) and its highlighted option. */
  readonly popover: { readonly id?: string; readonly pick: number }
  /** Agents the developer opened since they asked, by the `since` of the attention they saw. */
  readonly seen: Readonly<Record<string, number>>
  /** zarg's last reply the developer has seen; newer ones preview in the bar. */
  readonly readUpTo?: string
}
export const initialUi: Ui // { focus: "bar", sheet: false, pick: 0, other: false, agents: { toggled: {}, tree: 0 }, popover: { pick: 0 }, seen: {} }
export const sheetShown: (ui: Ui) => boolean              // ui.sheet || ui.viewing === undefined
export const typing: (ui: Ui, s: SessionState) => boolean   // the bar's input takes text
export const answeringOther: (ui: Ui, s: SessionState) => boolean
export const queueOf: (ui: Ui, s: SessionState) => ReadonlyArray<Prompt>  // the core's order, strictly FIFO
export const inputFocused: (ui: Ui, s: SessionState) => boolean // typing && queueOf(...).length === 0
export const focusBar: (ui: Ui, s: SessionState) => Ui
export const openAgent: (ui: Ui, s: SessionState, id: string) => Ui // zarg: the sheet; others: their view; marks attention seen
export type Action = …existing… | { readonly type: "answer-prompt"; readonly id: string; readonly choice: string } | { readonly type: "scroll-talk"; readonly delta: number }
export const onKey: (ui: Ui, s: SessionState, key: Key, now: number, draft?: string) => { readonly ui: Ui; readonly action?: Action; readonly draft?: string; readonly by?: string }
// layers.ts
export interface ShellWorld { readonly s: SessionState; readonly now: number; readonly draft: string }
export const SHELL: ReadonlyArray<InputLayer<Ui, ShellWorld, Action>>
```
`Ui.focus` values `"conversation"` and `"view"` are gone; `messageShown`, `otherFocused` and the Tab toggle between zarg and the agents are gone. `slashActive(ui, s)` becomes `typing(ui, s) && !answeringOther(ui, s)`.

**The helpers** (in `view.ts`):
```ts
const question = (s: SessionState) => s.thread.pendingInquiry
export const sheetShown = (ui: Ui) => ui.sheet || ui.viewing === undefined
/** Typing "Something else…" in the bar: the highlighted row is the free-text one. */
export const answeringOther = (ui: Ui, s: SessionState) => {
  const q = question(s)
  return q !== undefined && ui.other && ui.chatting !== q.id && ui.answered !== q.id
}
/** The bar takes text: it has focus, and nothing is asked, or the developer chats about the question or types their own answer. */
export const typing = (ui: Ui, s: SessionState) => {
  const q = question(s)
  return ui.focus === "bar" && (q === undefined || ui.chatting === q.id || answeringOther(ui, s))
}
/** The shared popover queue, in the order the core asked: nothing on the client reorders it. */
export const queueOf = (_ui: Ui, s: SessionState): ReadonlyArray<Prompt> => s.thread.prompts ?? []
export const inputFocused = (ui: Ui, s: SessionState) => typing(ui, s) && queueOf(ui, s).length === 0
/** The bar takes focus; while zarg asks, the sheet opens with the question. */
export const focusBar = (ui: Ui, s: SessionState): Ui => ({ ...ui, focus: "bar", sheet: ui.sheet || question(s) !== undefined })
const seenNow = (ui: Ui, s: SessionState, id: string): Ui => {
  const since = s.thread.rlms[id]?.attention?.since
  return since === undefined ? ui : { ...ui, seen: { ...ui.seen, [id]: since } }
}
/** Open an agent: zarg's sheet for zarg, the agent's view otherwise; either way its attention counts as seen. */
export const openAgent = (ui: Ui, s: SessionState, id: string): Ui => {
  const at = seenNow({ ...ui, agents: { ...ui.agents, cursor: id } }, s, id)
  if (id === "zarg") return { ...at, sheet: true, focus: "tile" }
  const { view: _, ...rest } = at
  return { ...rest, viewing: id, sheet: false, focus: "tile" }
}
```
`openHistory` is replaced by `openAgent`; `activate(ui, rlms, id)` becomes `activate(ui, s, id)` and calls `openAgent` for an open or childless node. `syncUi` also: when `sheetShown(ui)`, set `readUpTo` to the id of the last assistant message; when the popover head id changes, set `popover.pick` to the head's recommended option (or 0) and `popover.id` to the head's id.

**The layers** (`layers.ts`, top first). Each `hints` returns the keys the spec's table lists for it (strings shown after each layer).
```ts
import { type InputLayer, printable } from "@zarg/view"
type Layer = InputLayer<Ui, ShellWorld, Action>
const ARROWS = new Set(["left", "right", "up", "down"])

/** Alt+arrows move between the agents list, the tile area and the bar, as they sit on screen. */
const moveTile = (ui: Ui, s: SessionState, dir: string): Ui => {
  if (dir === "left") return { ...ui, focus: "agents" }
  if (dir === "right") return ui.focus === "agents" ? { ...ui, focus: "tile" } : ui
  if (dir === "down") return ui.focus === "tile" ? focusBar(ui, s) : ui
  return ui.focus === "bar" ? { ...ui, focus: "tile" } : ui
}
/** `/` from any panel: the bar opens with the slash typed (while zarg asks, as chat about the question). */
const slashFrom = (ui: Ui, s: SessionState) => {
  const q = s.thread.pendingInquiry
  return { ui: { ...focusBar(ui, s), ...(q !== undefined ? { chatting: q.id, other: false } : {}) }, draft: "/" }
}
/** g: the next agent that needs the developer, the ones not yet seen first, then tree order (zarg first). */
const nextAttention = (ui: Ui, s: SessionState) => {
  const all = attentionOf(s.thread.rlms)
  if (all.length === 0) return { ui }
  const unseen = all.filter((a) => ui.seen[a.id] !== s.thread.rlms[a.id]?.attention?.since)
  const order = [...unseen, ...all.filter((a) => !unseen.includes(a))]
  const next = order[(order.findIndex((a) => a.id === ui.attentionAt) + 1) % order.length]!
  return { ui: { ...openAgent(ui, s, next.id), attentionAt: next.id } }
}
const common = (ui: Ui, w: ShellWorld, k: InputKey) =>
  k.name === "g" ? nextAttention(ui, w.s) : k.name === "/" ? slashFrom(ui, w.s) : undefined

export const SHELL: ReadonlyArray<Layer> = [
  { id: "global", when: () => true, hints: () => [],
    handle: (ui, w, k) => {
      if (k.ctrl && k.name === "d") return { ui, action: { type: "exit" } }
      if (k.ctrl && k.name === "c") return ui.lastCtrlC !== undefined && w.now - ui.lastCtrlC < EXIT_WINDOW_MS ? { ui, action: { type: "exit" } } : { ui: { ...ui, lastCtrlC: w.now }, action: { type: "stop" } }
      if (k.meta && ARROWS.has(k.name)) return { ui: moveTile(ui, w.s, k.name) }
      if (k.meta && k.name === "a") return { ui: { ...ui, focus: "agents" } }
      if (k.meta && k.name === "v") return { ui: { ...ui, sheet: false, focus: "tile" } }
      if (k.meta && k.name === "m") return { ui: ui.focus === "bar" ? { ...ui, sheet: true } : focusBar(ui, w.s) }
      return "pass"
    } },
  { id: "popover", when: (ui, w) => queueOf(ui, w.s).length > 0, hints: () => [{ keys: "←→", does: "pick" }, { keys: "Enter", does: "choose" }],
    handle: (ui, w, k) => {
      const head = queueOf(ui, w.s)[0]!
      const n = head.options.length
      const pick = Math.min(ui.popover.pick, Math.max(0, n - 1))
      if (["left", "up"].includes(k.name)) return { ui: { ...ui, popover: { ...ui.popover, pick: Math.max(0, pick - 1) } } }
      if (["right", "down"].includes(k.name)) return { ui: { ...ui, popover: { ...ui.popover, pick: Math.min(n - 1, pick + 1) } } }
      if (k.name === "return" && head.options[pick] !== undefined)
        return { ui: { ...ui, popover: { pick: 0 } }, action: { type: "answer-prompt", id: head.id, choice: head.options[pick]!.id } }
      // Strictly first in, first out: a grant stays until answered (Esc included), and nothing jumps the queue.
      return { ui }
    } },
  { id: "slash", when: (ui, w) => typing(ui, w.s) && !answeringOther(ui, w.s) && w.draft.startsWith("/"), hints: () => [{ keys: "Tab", does: "complete" }, { keys: "↑↓", does: "pick" }, { keys: "Enter", does: "run" }, { keys: "Esc", does: "close" }],
    handle: (ui, w, k) => onSlashKey(ui, k, w.draft) ?? "pass" },
  { id: "bar", when: (ui, w) => typing(ui, w.s), hints: (ui, w) => [{ keys: "Enter", does: answeringOther(ui, w.s) ? "answer" : "send" }, { keys: "Esc", does: "leave" }],
    handle: (ui, w, k) => {
      // Letters, space and Backspace are the input's own: the renderer's input gets them, nobody else does.
      if (printable(k) || k.name === "return") return { ui }
      if (k.name !== "escape") return "pass"
      const q = w.s.thread.pendingInquiry
      if (q !== undefined && ui.chatting === q.id) { const { chatting: _, ...rest } = ui; return { ui: rest } }
      if (answeringOther(ui, w.s)) return { ui: { ...ui, other: false, pick: preselect(q!) } }
      return { ui: { ...ui, focus: "tile" } }
    } },
  { id: "picker", when: (ui, w) => {
      const q = w.s.thread.pendingInquiry
      return q !== undefined && ui.answered !== q.id && ui.chatting !== q.id && (ui.focus === "bar" || (ui.focus === "tile" && sheetShown(ui)))
    }, hints: () => [{ keys: "↑↓", does: "pick" }, { keys: "Enter", does: "answer" }],
    handle: (ui, w, k) => pickerKey(ui, w.s, k) },
  { id: "sheet", when: (ui) => ui.focus === "tile" && sheetShown(ui), hints: () => [{ keys: "PgUp PgDn", does: "scroll" }, { keys: "Esc", does: "collapse" }],
    handle: (ui, w, k) => {
      if (k.name === "pageup" || k.name === "pagedown") return { ui, action: { type: "scroll-talk", delta: k.name === "pageup" ? -10 : 10 } }
      if (k.name === "up" || k.name === "down") return { ui, action: { type: "scroll-talk", delta: k.name === "up" ? -1 : 1 } }
      // With no agent open the sheet is all there is: Esc hands the keys to the agents list.
      if (k.name === "escape") return { ui: ui.viewing === undefined ? { ...ui, sheet: false, focus: "agents" } : { ...ui, sheet: false } }
      return common(ui, w, k) ?? "pass"
    } },
  { id: "view", when: (ui) => ui.focus === "tile" && !sheetShown(ui), hints: () => [{ keys: "Tab", does: "sections" }, { keys: "[ ]", does: "tabs" }, { keys: "Space", does: "select" }, { keys: "Esc", does: "close" }],
    handle: (ui, w, k) => {
      if (k.name === "escape") { const { viewing: _, view: __, ...rest } = ui; return { ui: rest } }
      const c = common(ui, w, k)
      if (c !== undefined) return c
      const v = w.s.thread.views?.[ui.viewing!]
      if (v === undefined) return { ui }
      const r = viewKeys(v, ui.view ?? startUi(v), k)
      return { ui: { ...ui, view: r.ui }, ...(r.act !== undefined ? { action: { type: "act" as const, ...r.act } } : r.answer !== undefined ? { action: { type: "answer-agent" as const, ...r.answer } } : r.scroll !== undefined ? { action: { type: "scroll" as const, delta: r.scroll } } : {}) }
    } },
  { id: "agents", when: (ui) => ui.focus === "agents", hints: () => [{ keys: "↑↓", does: "move" }, { keys: "←→", does: "fold" }, { keys: "Enter", does: "open" }, { keys: "g", does: "next ◆" }],
    handle: (ui, w, k) => common(ui, w, k) ?? { ui: onAgentsKey(ui, w.s, k) } },
]
```
`pickerKey(ui, s, k)` is today's picker branch of `onKey` moved into a function that returns `"pass"` for keys it does not own, with two changes: Enter on "Something else…" or "Chat about this" also sets `focus: "bar"` (the bar takes the typing); Esc while not on "Something else…" and the bar has focus returns `{ ui: { ...ui, focus: "tile" } }`. `onAgentsKey(ui, s, k)` takes the session state (for `activate(ui, s, id)`). `onKey` becomes:
```ts
export const onKey = (ui: Ui, s: SessionState, key: Key, now: number, draft?: string) => dispatch(SHELL, ui, { s, now, draft: draft ?? "" }, key)
```
`onSubmit`: a `send` also returns `ui: { ...ui, sheet: true }` (the reply is seen); answering "Something else…" leaves focus in the bar. Since `layers.ts` imports helpers from `view.ts` and `view.ts` re-exports nothing from `layers.ts`, `onKey` lives in `layers.ts` and `view.ts` stops exporting it; `index.ts` adds `export * from "./layers"`.

- [ ] **Step 1: Write the failing tests** (`packages/view-tui/test/layers.test.ts`)

```ts
import { describe, expect, test } from "bun:test"
import { initial, type Inquiry, type SessionState } from "@zarg/client"
import { onKey } from "../src/layers"
import { initialUi, type Ui } from "../src/view"

const inquiry: Inquiry = { id: "inq-1", question: "Which card first?", options: [{ id: "a", label: "Login" }, { id: "b", label: "Checkout", recommended: true }], allowOther: true, about: [] }
const grant = (id: string) => ({ id, question: `Plugin ${id} wants to load.`, options: [{ id: "always", label: "Allow" }, { id: "deny", label: "Not now" }], kind: "grant" as const })
const idle: SessionState = { thread: { ...initial("main") }, core: "up" }
const asking: SessionState = { thread: { ...initial("main"), status: "waiting", pendingInquiry: inquiry }, core: "up" }
const withView: SessionState = { ...idle, thread: { ...idle.thread, views: { "rehearse:t1": { agent: "rehearse:t1", layout: { name: "t", sections: [{ id: "findings", kind: "table", role: "primary", columns: [{ id: "c", label: "C" }], actions: [{ id: "apply", label: "Apply", key: "a", on: "row" }] }] }, data: { findings: { rows: [{ id: "r1", cells: { c: "x" } }] } } } } } }
const key = (name: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({ name, ...mods })
const at = (ui: Partial<Ui>): Ui => ({ ...initialUi, ...ui })

describe("the shell's layers", () => {
  test("the bar owns printable keys while typing", () => {
    for (const k of ["g", "x", "/", "[", "a", "space", "backspace"]) {
      const r = onKey(at({ focus: "bar" }), withView, key(k), 0, "hello")
      expect([k, r.by, r.action]).toEqual([k, "bar", undefined])
    }
  })
  test("Alt keys work while typing: Alt+left goes to the agents, alt+v to the view", () => {
    expect(onKey(at({ focus: "bar" }), idle, key("left", { meta: true }), 0).ui.focus).toBe("agents")
    expect(onKey(at({ focus: "bar", viewing: "rehearse:t1" }), withView, key("v", { meta: true }), 0).ui).toMatchObject({ focus: "tile", sheet: false })
  })
  test("alt+m focuses the bar; a second alt+m opens the sheet; while zarg asks, focusing the bar opens it at once", () => {
    const once = onKey(at({ focus: "agents", viewing: "rehearse:t1" }), withView, key("m", { meta: true }), 0).ui
    expect(once).toMatchObject({ focus: "bar", sheet: false })
    expect(onKey(once, withView, key("m", { meta: true }), 0).ui.sheet).toBe(true)
    expect(onKey(at({ focus: "agents", viewing: "rehearse:t1" }), asking, key("m", { meta: true }), 0).ui).toMatchObject({ focus: "bar", sheet: true })
  })
  test("/ from the agents list opens the bar with the slash typed", () => {
    expect(onKey(at({ focus: "agents" }), idle, key("/"), 0)).toMatchObject({ ui: { focus: "bar" }, draft: "/", by: "agents" })
  })
  test("the slash box takes ↑↓ only while open", () => {
    expect(onKey(at({ focus: "bar" }), idle, key("down"), 0, "/re").by).toBe("slash")
    expect(onKey(at({ focus: "bar" }), asking, key("down"), 0, "").by).toBe("picker")
  })
  test("a question never takes keys from another panel", () => {
    expect(onKey(at({ focus: "tile", viewing: "rehearse:t1" }), { ...withView, thread: { ...withView.thread, pendingInquiry: inquiry } }, key("down"), 0).by).toBe("view")
    expect(onKey(at({ focus: "agents" }), asking, key("down"), 0).by).toBe("agents")
  })
  test("a popover takes every key but the global ones", () => {
    const s = { ...idle, thread: { ...idle.thread, prompts: [grant("p1")] } }
    expect(onKey(at({ focus: "bar" }), s, key("a"), 0, "").by).toBe("popover")
    expect(onKey(at({ focus: "bar" }), s, key("left", { meta: true }), 0).by).toBe("global")
    expect(onKey(at({ focus: "bar" }), s, key("return"), 0).action).toEqual({ type: "answer-prompt", id: "p1", choice: "always" })
  })
  test("the queue is strictly first in, first out: Esc never reorders it", () => {
    const s = { ...idle, thread: { ...idle.thread, prompts: [grant("p1"), grant("p2")] } }
    const r = onKey(at({}), s, key("escape"), 0)
    expect(r.by).toBe("popover")
    expect(onKey(r.ui, s, key("return"), 0).action).toEqual({ type: "answer-prompt", id: "p1", choice: "always" })
  })
  test("PgUp scrolls zarg's sheet; Esc collapses it back to the view", () => {
    const ui = at({ focus: "tile", sheet: true, viewing: "rehearse:t1" })
    expect(onKey(ui, withView, key("pageup"), 0).action).toEqual({ type: "scroll-talk", delta: -10 })
    expect(onKey(ui, withView, key("escape"), 0).ui).toMatchObject({ sheet: false, viewing: "rehearse:t1" })
  })
  test("Enter on zarg's row opens the sheet; on another agent it opens its view and closes the sheet", () => {
    const rlms = { zarg: { id: "zarg", parent: null, preset: "zarg", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [] }, "rehearse:t1": { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [] } }
    const s = { ...withView, thread: { ...withView.thread, rlms } }
    expect(onKey(at({ focus: "agents", agents: { cursor: "zarg", toggled: {}, tree: 0 } }), s, key("return"), 0).ui).toMatchObject({ sheet: true, focus: "tile" })
    expect(onKey(at({ focus: "agents", sheet: true, agents: { cursor: "rehearse:t1", toggled: {}, tree: 0 } }), s, key("return"), 0).ui).toMatchObject({ sheet: false, focus: "tile", viewing: "rehearse:t1" })
  })
  test("an agent's action key works only in its view", () => {
    const ui = at({ focus: "tile", viewing: "rehearse:t1" })
    expect(onKey(ui, withView, key("a"), 0).action).toMatchObject({ type: "act", action: "apply" })
    expect(onKey({ ...ui, focus: "agents" }, withView, key("a"), 0).action).toBeUndefined()
  })
  test("Ctrl-C once stops, twice exits; Ctrl-D exits", () => {
    const r = onKey(at({}), idle, key("c", { ctrl: true }), 1000)
    expect(r.action).toEqual({ type: "stop" })
    expect(onKey(r.ui, idle, key("c", { ctrl: true }), 1500).action).toEqual({ type: "exit" })
    expect(onKey(at({}), idle, key("d", { ctrl: true }), 0).action).toEqual({ type: "exit" })
  })
})
```

- [ ] **Step 2: Run** — `mise //packages/view-tui:test -- layers` — Expected: FAIL, cannot find `../src/layers`.
- [ ] **Step 3: Implement** `layers.ts` and the `view.ts` changes above.
- [ ] **Step 4: Migrate `packages/view-tui/test/view.test.ts`.** Import `onKey` from `../src/layers`. Change expectations, never the behaviour they pin, by this table:

| old | new |
|---|---|
| `focus: "conversation"` | `focus: "bar"` (typing or picking) or `focus: "tile"` with `sheet: true` |
| `focus: "view"` | `focus: "tile"` with `viewing` set and `sheet: false` |
| Tab switches zarg ↔ agents | Alt+arrows / `alt+a` / `alt+m` (Tab now belongs to the view only) |
| `messageShown`, `otherFocused` | `typing`, `answeringOther` |
| `openHistory(ui, id)` | `openAgent(ui, s, id)` |
| `activate(ui, rlms, id)` | `activate(ui, s, id)` |
| g on zarg gives the conversation the keys | g on zarg opens the sheet (`sheet: true, focus: "tile"`) |
| Escape in the view goes back to the conversation | Escape in the view closes it (the sheet shows, focus stays `tile`) |

Delete tests whose subject no longer exists (the Tab toggle) and say so in the ledger.
- [ ] **Step 5: Run** — `mise //packages/view-tui:test -- layers view` — Expected: PASS. `app.test.tsx` may fail until Task 5; mark failing frame tests `test.skip` with `// Task 5 redraws the shell` and ledger it.
- [ ] **Step 6: Commit** — `mise run verify` then `git commit -m "refactor(tui): the shell's keys go through input layers"`.

---

### Task 5: The layout: agents list, tile area, message bar, sheet, popover

**Files:**
- Modify: `packages/view-tui/src/app.tsx` (rewrite the render), `packages/view-tui/src/view.ts` (`barLine`, `titleHot`)
- Test: `packages/view-tui/test/app.test.tsx` (new frame tests; migrate the skipped ones)

**Interfaces — Consumes:** Task 4 (everything in its Produces block), Task 3 (`session.answerPrompt`).

**Interfaces — Produces** (`view.ts`):
```ts
/** What the bar shows when it is not an input: the question, the working line, an unread reply, or the prompt. */
export const barLine: (ui: Ui, s: SessionState, now: number) => { readonly text: string; readonly tone: "question" | "working" | "reply" | "idle" }
/** A panel name with its Alt letter: the letter's index in `name`, or -1 when it is shown before the name. */
export const titleHot: (name: string, letter: string) => { readonly before: string; readonly letter: string; readonly after: string }
```
`barLine`: a question not being chatted about → `? <question>   alt+m or / to answer` (`question`); zarg working (`working(ui, s, now)` is defined) → that line (`working`); the last assistant message id ≠ `ui.readUpTo` and the sheet is not shown → `zarg: <text cut to 60 chars>` (`reply`); otherwise `message zarg… (alt+m or /)` (`idle`). `titleHot("Agents ◆1", "a")` → `{ before: "", letter: "A", after: "gents ◆1" }`; `titleHot("rehearse r-3f2a", "v")` → `{ before: "v ", letter: "", after: "rehearse r-3f2a" }` (the letter shown before the name, coloured).

**The render** (replacing everything from `const zargTile` to the end of `App`):
- Root: `<box flexDirection="row" width="100%" height="100%">`.
- Left, wide only: the agents list, `width: 30`, full height, border accent when `ui.focus === "agents"`. First row: a `<text>` header built from `titleHot(\`Agents${n > 0 ? \` ◆${n}\` : ""}\`, "a")` with the letter coloured `#8ab4f8` and underlined (`<u>`), then ` alt+a` dim. Then the rows (as today, `onMouseDown` → `setUi(activate(latest(), state, a.id))`), the detail card, and a footer with the agents layer's hints.
- Right: `<box flexDirection="column" flexGrow={1}>` with, in order:
  - narrow only: the one-line strip (as today) — and when `ui.focus === "agents"` the agents list takes the tile area's place;
  - the tile area (`flexGrow: 1`, `onMouseDown` → focus `tile`): when `sheetShown(ui)`, zarg's sheet: a rounded border, header `zarg` and `Esc collapse`, the scrollbox of `conversation(s)` lines (ref kept for `scroll-talk`, `focusable={false}`), the working line, then the picker rows (options, "Something else…", "Chat about this"; no input inside, the typing is in the bar); otherwise the view tile with header `titleHot(viewing, "v")` and `AgentView` as today;
  - the slash box above the bar while `slashActive(ui, s)` and the draft is a slash command (as today);
  - the bar: `height: 3`, border accent when `ui.focus === "bar"`, `onMouseDown` → `setUi(focusBar(latest(), state))`. When `typing(ui, s)`: a label (`message ›`, `answer ›` while `answeringOther`, `chat ›` while chatting) and the one `<input ref={inputRef} focused={inputFocused(ui, s)} …>` with today's `onInput` / `onSubmit` (the Something-else draft is merged into this one draft). Otherwise `barLine(ui, s, now)` in its tone's colour (question: `#fdd663`, working: accent, reply and idle: dim);
  - the status line (one line): `statusLine(s, meta)`, then `s.notice` when set, then `hintsOf(SHELL, ui, world).map((h) => \`${h.keys} ${h.does}\`).join(" · ")`.
- The popover, last child of the root so it draws on top: when `queueOf(ui, s)[0]` exists, `<box position="absolute" left={center} top={4} width={Math.min(56, dims.width - 4)} border borderStyle="double" borderColor="#fdd663" backgroundColor="#2d2f31">` with a header `grant  N of M · next: <next question cut to 30>` (just `grant` when alone), the question, its options on one line with the highlighted one on `#3c4043` (each option `onMouseDown` → `act({ type: "answer-prompt", id, choice })`), and `←→ pick · Enter choose`.
- `act` handles `answer-prompt` (`void props.session.answerPrompt(a.id, a.choice)`) and `scroll-talk` (`talkRef.current?.scrollBy(a.delta)`).

- [ ] **Step 1: Write the failing frame tests** (in `app.test.tsx`, a new `describe("the shell", …)`, rendered at 130×22 unless said; `render(state, ui?)` is the file's existing helper pattern: `testRender(<App session={fake.session} meta={meta} onExit={() => {}} />, { width, height, ...RENDERER })`):

```ts
describe("the shell", () => {
  test("the agents list runs full height on the left; the bar sits under the tile area only", async () => {
    const t = await testRender(<App session={fakeSession(idleState).session} meta={meta} onExit={() => {}} />, { width: 130, height: 22, ...RENDERER })
    await t.renderOnce()
    const lines = t.captureCharFrame().split("\n")
    expect(lines[0]).toContain("Agents")
    expect(lines.findIndex((l) => l.includes("message zarg…"))).toBeGreaterThan(10)
    // The agents list's border is still on the bar's row: the bar does not run under it.
    const bar = lines.find((l) => l.includes("message zarg…"))!
    expect(bar.indexOf("message zarg…")).toBeGreaterThan(30)
    t.renderer.destroy()
  })
  test("zarg asks: the bar shows the question on one line; alt+m opens the sheet with the picker", async () => {
    const fake = fakeSession(waiting)
    const t = await testRender(<App session={fake.session} meta={meta} onExit={() => {}} />, { width: 130, height: 22, ...RENDERER })
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("? Which card first?")
    t.mockInput.pressKey("m", { meta: true })
    await t.renderOnce()
    const f = t.captureCharFrame()
    expect(f).toContain("Esc collapse")
    expect(f).toContain("› Checkout (recommended)")
    t.renderer.destroy()
  })
  test("a grant popover shows over everything with its place in the queue; Enter answers it", async () => {
    const fake = fakeSession({ ...idleState, thread: { ...idleState.thread, prompts: [grantPrompt("p1"), grantPrompt("p2")] } })
    const t = await testRender(<App session={fake.session} meta={meta} onExit={() => {}} />, { width: 130, height: 22, ...RENDERER })
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("grant  1 of 2")
    t.mockInput.pressEnter()
    await t.renderOnce()
    expect(fake.calls).toContain("prompt p1 always")
    t.renderer.destroy()
  })
  test("a grant popover blurs the bar; answering it gives the bar back", async () => {
    const fake = fakeSession(idleState)
    const t = await testRender(<App session={fake.session} meta={meta} onExit={() => {}} />, { width: 130, height: 22, ...RENDERER })
    await t.renderOnce()
    await t.mockInput.typeText("hel")
    fake.update({ ...idleState, thread: { ...idleState.thread, prompts: [grantPrompt("p1")] } })
    await t.renderOnce()
    await t.mockInput.typeText("xx")
    fake.update(idleState)
    await t.renderOnce()
    await t.mockInput.typeText("lo")
    t.mockInput.pressEnter()
    await t.renderOnce()
    expect(fake.calls).toContain("send hello")
    t.renderer.destroy()
  })
  test("hotkey letters show in the panels' names", async () => {
    const t = await testRender(<App session={fakeSession(viewState).session} meta={meta} onExit={() => {}} />, { width: 130, height: 22, ...RENDERER })
    await t.renderOnce()
    const f = t.captureCharFrame()
    expect(f).toContain("Agents")
    expect(f).toContain("alt+a")
    expect(f).toContain("alt+m")
    t.renderer.destroy()
  })
  test("at 80×24 the agents fold to a strip above the tile area; alt+a unfolds them there", async () => {
    const t = await testRender(<App session={fakeSession(waiting).session} meta={meta} onExit={() => {}} />, { width: 80, height: 24, ...RENDERER })
    await t.renderOnce()
    expect(t.captureCharFrame().split("\n")[0]).toContain("Agents")
    t.mockInput.pressKey("a", { meta: true })
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("rlm-1")
    t.renderer.destroy()
  })
})
```
Define next to `waiting`: `idleState` (`{ thread: { ...initial("main"), messages: [{ id: "m1", role: "assistant", text: "Hello." }] }, core: "up" }`), `viewState` (idle plus the `rehearse:t1` view and row from `layers.test.ts`, `viewing` reached by pressing Enter on the row), and `grantPrompt(id)` (as `grant` in `layers.test.ts`).

- [ ] **Step 2: Run** — `mise //packages/view-tui:test -- app` — Expected: the new tests FAIL (old layout).
- [ ] **Step 3: Implement** the render above.
- [ ] **Step 4: Migrate the skipped frame tests** from Task 4 by the same table, plus: "zarg's conversation is a tile" becomes "zarg's sheet shows while no agent is open"; the 38% width assertions go; the narrow tests look for the strip at line 0. Keep the regression tests (clicks never give a scrollbox the arrows; the view keeps every section's title at 80×20).
- [ ] **Step 5: Run** — `mise run verify` — Expected: PASS. Look at one 130×22 and one 80×24 frame by printing them in a scratch run (`mise x -- bun packages/view-tui/mockups/sheet.tsx` shows the target) and compare.
- [ ] **Step 6: Commit** — `git commit -m "feat(tui): the shell: agents list, tile area, message bar, zarg's sheet, grant popovers"`.

---

### Task 6: Attention pulses until seen

**Files:**
- Modify: `packages/view-tui/src/view.ts` (`AgentRow.pulse`, `agentRows` takes `seen`, `animating`), `packages/view-tui/src/app.tsx` (row colours)
- Test: `packages/view-tui/test/view.test.ts`

**Interfaces — Produces:**
```ts
export interface AgentRow { …; readonly pulse?: "on" | "off" } // set while its attention is unseen; the phase follows `now`
export const agentRows: (rlms, agents: Agents, cols?: number, now?: number, seen?: Readonly<Record<string, number>>) => ReadonlyArray<AgentRow>
export const PULSE_MS = 500
```

- [ ] **Step 1: Write the failing test** (in `view.test.ts`, `describe("attention")`)

```ts
  test("an unseen request pulses (◆ then ◇ every 500 ms); once opened the ◆ stays steady", () => {
    const rlms = { "rehearse:t1": { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [], attention: { reason: "4 findings", since: 100 } } }
    const agents = { toggled: {}, tree: 0 }
    expect(agentRows(rlms, agents, 46, 0, {})[0]).toMatchObject({ pulse: "on" })
    expect(agentRows(rlms, agents, 46, 0, {})[0]!.text).toContain("◆")
    expect(agentRows(rlms, agents, 46, 500, {})[0]).toMatchObject({ pulse: "off" })
    expect(agentRows(rlms, agents, 46, 500, {})[0]!.text).toContain("◇")
    const seen = agentRows(rlms, agents, 46, 500, { "rehearse:t1": 100 })[0]!
    expect(seen.pulse).toBeUndefined()
    expect(seen.text).toContain("◆")
  })
  test("the screen animates while something pulses, and stops once everything is seen", () => {
    const s = { ...waiting, thread: { ...waiting.thread, pendingInquiry: undefined, status: "idle" as const, rlms: { t: { id: "t", parent: null, preset: "tester", depth: 0, turns: 0, budget: 0, status: "done" as const, decisions: [], attention: { reason: "r", since: 7 } } } } }
    expect(animating({ ...initialUi }, s)).toBe(true)
    expect(animating({ ...initialUi, seen: { t: 7 } }, s)).toBe(false)
  })
  test("g goes to unseen requests first, then tree order", () => {
    // zarg asked earlier and was seen; the tester asks now: g goes to the tester first.
    const rlms = {
      zarg: { id: "zarg", parent: null, preset: "zarg", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [], attention: { reason: "asks", since: 1 } },
      "rehearse:t1": { id: "rehearse:t1", parent: null, preset: "tester", depth: 0, turns: 0, budget: 0, status: "running" as const, decisions: [], attention: { reason: "r", since: 2 } },
    }
    const s = { ...waiting, thread: { ...waiting.thread, rlms } }
    expect(onKey({ ...initialUi, focus: "agents", seen: { zarg: 1 } }, s, { name: "g" }, 0).ui).toMatchObject({ viewing: "rehearse:t1", seen: { zarg: 1, "rehearse:t1": 2 } })
  })
```

- [ ] **Step 2: Run** — Expected: FAIL (`pulse` undefined; `animating` false).
- [ ] **Step 3: Implement.** In `agentRows`, for a node with attention: `const unseen = seen?.[n.id] !== n.attention.since`, the icon `unseen && now !== undefined && Math.floor(now / PULSE_MS) % 2 === 1 ? "◇" : "◆"`, and `pulse: unseen ? (Math.floor((now ?? 0) / PULSE_MS) % 2 === 0 ? "on" : "off") : undefined`. `animating` also returns true when any node's attention is unseen by `ui.seen`. In `app.tsx` pass `ui.seen`, and colour a row: `pulse === "on"` → attention colour `#fdd663` and the name upper-cased is not needed (colour only); `pulse === "off"` → normal colour with the ◇; seen attention → `#fdd663` steady. Opening an agent already marks it seen (`openAgent`, Task 4).
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(tui): attention pulses until the developer looks"`.

---

### Task 7: Agents own their key mappings, per platform

**Files:**
- Create: `packages/view/src/keys.ts`
- Modify: `packages/view/src/schema.ts` (`Action.keys`, `LayoutSchema.actions`), `packages/view/src/layout.ts` (`defineView(name, sections, opts?)`, checks, `layoutOf` carries `actions`), `packages/view/src/behaviour.ts` (`actionFor(view, ui, key, platform = "terminal")`), `packages/view/src/index.ts`, `packages/plugin/src/server/host.ts` (`manifestProblem` checks views' keys)
- Test: `packages/view/test/layout.test.ts`, `packages/view/test/behaviour.test.ts`, `packages/plugin/test/load-waiting.test.ts`

**Interfaces — Produces:**
```ts
// keys.ts
export const RESERVED_TERMINAL: ReadonlySet<string> // up down left right tab shift+tab return enter escape space pageup pagedown [ ] g x /
export const reservedFor: (platform: string, key: string) => boolean // terminal: RESERVED_TERMINAL or /^(ctrl|alt|meta|option)\+/
export const keyFor: (a: { readonly key?: string; readonly keys?: Readonly<Record<string, string>> }, platform: string) => string | undefined
/** Why a view's action keys are refused, or undefined: a reserved key, or one key twice in the view. */
export const keysProblem: (layout: Layout) => string | undefined
// schema.ts
Action: { id, label, key?, keys?: Record<string, string>, on }
LayoutSchema: { name, sections, actions?: Action[] }   // view-level actions (`on: "none"`)
// layout.ts
export const defineView: <const S extends ViewSpec>(name: string, sections: S, opts?: { readonly actions?: ReadonlyArray<ActionSpec> }) => ViewDef<S>
// ViewDef gains `readonly actions?: ReadonlyArray<ActionSpec>`; ActionSpec gains `keys?`
```

`keysProblem`:
```ts
export const keysProblem = (layout: Layout): string | undefined => {
  const leaves = layout.sections.flatMap((s) => (s.kind === "tabs" ? s.tabs : [s]))
  const all = [...leaves.flatMap((l) => l.actions ?? []), ...(layout.actions ?? [])]
  const seen = new Set<string>()
  for (const a of all) {
    for (const [platform, key] of Object.entries({ ...(a.keys ?? {}), ...(a.key !== undefined ? { terminal: a.key } : {}) })) {
      if (reservedFor(platform, key)) return `view ${layout.name}: action ${a.id} maps ${key}, a key ${platform} keeps for itself`
      if (seen.has(`${platform}:${key}`)) return `view ${layout.name}: ${key} is mapped twice on ${platform}`
      seen.add(`${platform}:${key}`)
    }
  }
  return undefined
}
```
`defineView` calls `keysProblem(layoutOf(def))` and throws its message. `actionFor` looks the key up with `keyFor(a, platform)` in the focused table first, then in `view.layout.actions` (returning `{ section: undefined, action: a.id, rows: [] }`; the return type's `section` becomes `string | undefined`). `manifestProblem` adds, after the command checks: `for (const v of m.views ?? []) { const p = keysProblem(v as Layout); if (p !== undefined) return p }` (import `keysProblem` from `@zarg/view`; the host already depends on it through the SDK — add `"@zarg/view": "workspace:*"` to `packages/plugin/package.json` with `bun add` if it does not).

- [ ] **Step 1: Write the failing tests**

`layout.test.ts`:
```ts
test("an action on a reserved key, or two actions on one key, are refused; another platform's mapping is kept", () => {
  const table = (actions: ReadonlyArray<Record<string, unknown>>) => ({ t: { kind: "table" as const, role: "primary" as const, columns: [{ id: "c", label: "C" }], actions: actions as never } })
  expect(() => defineView("v", table([{ id: "a", label: "A", key: "tab", on: "row" }]))).toThrow(/tab, a key terminal keeps/)
  expect(() => defineView("v", table([{ id: "a", label: "A", keys: { terminal: "ctrl+a" }, on: "row" }]))).toThrow(/ctrl\+a/)
  expect(() => defineView("v", table([{ id: "a", label: "A", key: "/", on: "row" }]))).toThrow(/\//)
  expect(() => defineView("v", table([{ id: "a", label: "A", key: "r", on: "row" }]), { actions: [{ id: "b", label: "B", key: "r", on: "none" }] })).toThrow(/mapped twice/)
  expect(layoutOf(defineView("v", table([{ id: "a", label: "A", keys: { terminal: "a", web: "mod+enter" }, on: "row" }]))).sections[0]).toMatchObject({ actions: [{ keys: { terminal: "a", web: "mod+enter" } }] })
})
```
`behaviour.test.ts`:
```ts
test("a view-level action fires from any section; keys.terminal works like key", () => {
  const view = { agent: "a", layout: { name: "v", sections: [{ id: "log", kind: "log" as const, role: "log" as const }, { id: "t", kind: "table" as const, role: "primary" as const, columns: [], actions: [{ id: "apply", label: "Apply", keys: { terminal: "a" }, on: "row" as const }] }], actions: [{ id: "rerun", label: "Rerun", keys: { terminal: "r" }, on: "none" as const }] }, data: { t: { rows: [{ id: "r1", cells: {} }] } } }
  expect(actionFor(view, { ...initialViewUi, focus: 0 }, "r")).toEqual({ section: undefined, action: "rerun", rows: [] })
  expect(actionFor(view, { ...initialViewUi, focus: 1 }, "a")).toEqual({ section: "t", action: "apply", rows: ["r1"] })
  expect(actionFor(view, { ...initialViewUi, focus: 1 }, "a", "web")).toBeUndefined()
})
```
(`ordered` puts the `primary` table before the `log`, so adjust `focus` indexes to what `ordered` gives if they differ; the assertion is on which action fires.)

`load-waiting.test.ts` (next to "a bundle that claims the trusted runtime is refused"), using that test's fixture helpers to write a manifest whose view has `actions: [{ id: "a", label: "A", key: "tab", on: "row" }]` on a table section:
```ts
  test("the host refuses an action mapped to a reserved key", async () => {
    // same setup as the trusted-runtime test, with the manifest's views patched as above
    expect(item?.detail ?? item?.title).toMatch(/tab, a key terminal keeps for itself/)
  })
```

- [ ] **Step 2: Run** — `mise //packages/view:test && mise //packages/plugin:test -- load-waiting` — Expected: FAIL.
- [ ] **Step 3: Implement** as above; the view layer's hints (Task 4, `view` layer) append the open view's terminal mappings: `{ keys: keyFor(a, "terminal")!, does: a.label }` for the focused table's actions and the view-level actions.
- [ ] **Step 4: Run** — `mise run build:plugins && mise run verify` — Expected: PASS (first-party plugins rebuilt; their hashes updated in `first-party-hashes.ts`).
- [ ] **Step 5: Commit** — `git commit -m "feat: agents own their key mappings, per platform; reserved keys refused"`.

---

### Task 8: End to end and docs

**Files:**
- Modify: `packages/cli/test/tui.e2e.test.tsx` (un-skip; the grant is a popover), `AGENTS.md`

- [ ] **Step 1: Update the e2e test.** Replace the grant part with: wait for `"grant"` and `"Plugin rehearse wants to load"` in the frame; press `right` (to "Not now") and Enter; then continue as before. zarg's question is now in the bar (`? Which card first?`): press `alt+m` (`t.mockInput.pressKey("m", { meta: true })`) to open the sheet, then wait for `"› Checkout (recommended)"`, Enter, wait for `"What next?"`. The assertions on `"you  Checkout"` and `"zarg  Working on Checkout."` hold inside the sheet (the sheet stays open after answering).
- [ ] **Step 2: Run** — `mise //packages/cli:test -- tui.e2e` — Expected: PASS.
- [ ] **Step 3: Update `AGENTS.md`**: the `view` line gains "input layers (`dispatch`) and per-platform action keys (`keys: { terminal, web }`, reserved keys refused)"; the `view-tui` line becomes: "the terminal platform: the agents list (full height, left), the open agent's view in the tile area, zarg's message bar under it that opens into zarg's sheet, grant popovers queued first in first out; keys go through input layers (`alt+a` agents, `alt+v` view, `alt+m` message, `/` commands, `g` the next agent asking, Alt+arrows between panels). Never imports `@zarg/core` or a `/server` subpath." The `core` line gains "grants as prompts (`zarg.prompt`, `POST /prompts/:id`)".
- [ ] **Step 4: Run** — `mise run verify` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "docs: the shell; test: end to end through the grant popover and zarg's sheet"`.

## Self-review notes

- Spec coverage: layout and narrow (Task 5); message bar states, focus ways, Enter/Esc (Tasks 4, 5); zarg's sheet open/stay/close rules (Task 4 layers, Task 5 render); shared FIFO popover queue kept by the core, grants as prompts, keys, withdrawal, other clients (Tasks 2, 3, 4, 5); attention pulse and `g` order (Task 6); hotkeys (Tasks 4, 5); input layers table (Task 4); agents' key mappings and view-level actions (Task 7); errors: zarg not loaded is unchanged (the not-loaded thread still says why in the sheet), prompts withdrawn on restart and on asker exit (Task 2). Surfaces (`tile | panel | popover | sheet` declared by plugins) are plan 2.
- Rulings to ledger at execution: `Thread.ask` stays unused until plan 2; the status line stays (core state, YOLO, notice, hints) under the bar; notices also show on the status line since the sheet may be closed; the working line shows in the bar while the sheet is closed; Tab no longer toggles zarg and the agents.
