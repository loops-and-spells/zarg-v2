# Agents Everywhere, Tiled Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zarg becomes a trusted first-party agent plugin (`agent-zarg`), rehearse a sandboxed agent (`agent-rehearse`), and the TUI a tiling shell where zarg's conversation is always on screen beside the open agent's view, with attention (◆) for agents that need the developer.

**Architecture:** A new types package `@zarg/agent-host` defines the `Thread` interface the core serves, the `AgentHost` interface the core gives trusted agents, and the trusted-agent contract. The driver loop and its helpers move from `core` into `agent-zarg`, which the core loads by path from zarg's own packages and starts on `main`. `@zarg/view` gains a `conversation` section kind and its behaviour; attention is a field on agent rows set through the SDK or `AgentHost`; the terminal shell tiles zarg's conversation, the open view and the agents tree, moving between tiles with Alt+arrows.

**Tech Stack:** Bun (via `mise x -- bun`), TypeScript, Effect 4, React 19, opentui 0.5.12, AG-UI 1.0.

**Spec:** `docs/superpowers/specs/2026-09-27-agents-tiled-shell-design.md`

## Global Constraints

- Run every tool through mise (`mise x -- bun …`, `mise x -- bunx tsc`); tests spawn `process.execPath`. `bun add` / `bun remove` from the package directory; commit `bun.lock`.
- `mise run verify` must pass before every commit.
- One package = one module; depend on packages by name, never relative paths across packages. A package never imports a plugin or agent package except its `/contract` (the import-rule test); trusted agents are loaded by the core by path at runtime.
- `archetype: "agent"`; `runtime: "trusted" | "sandboxed"`, default `sandboxed`. Only first-party packages run trusted.
- Package names: `agent-*` agents, `provider-*` providers, `plugin-*` graph and service plugins. Rehearse's plugin name stays `rehearse`.
- The `conversation` section: `messages: [{ id, role: "user" | "agent", text }]`, `question?: { id, question, options: [{ id, label, why?, recommended? }], allowOther, otherLabel?, kind?: "grant" }`, `status?: "idle" | "working" | "waiting"`. One slot: the question or the message input, never both.
- Attention: `attention?: { reason, since }` on an agent row; `Attention.request(agent, reason)` / `clear(agent)`.
- Shell: Alt+arrows between tiles; Tab between sections in a tile; narrow layout under 100 columns; `g` opens the next agent needing the developer (tree order, zarg first).
- zarg's conversation stays on AG-UI (messages, interrupts, `/runs`).
- YOLO never asks; without YOLO permission questions are zarg's `kind: "grant"` questions.
- Never print, log or commit a secret; tests use unique variable names; tests never write `~/.config/zarg`.
- Do not start a core or the TUI in the repo root; no live models or GPU.

## Review Focus

1. `agent-zarg` fails to load or throws in `start`: the core still serves, `main` answers with "zarg is not loaded: <reason>", the TUI's zarg tile says so. → Task 3, test "without agent-zarg the core serves and main says why".
2. A question arrives while the developer is in another tile: keys never reach the picker until zarg's tile has focus; nothing is answered by accident. → Task 8, test "a question waits while the view tile has focus: arrows move the view".
3. A narrow terminal (80×24) with three tiles and a tall table: zarg's tile keeps its slot visible, the strip shows every ◆. → Task 8, test "at 80×24 zarg is above the view and the strip lists attention".
4. Attention from an agent that then ends or is stopped (or a core restart): no ◆ lingers. → Task 6, test "attention clears when the agent ends and on a core restart".
5. A sandboxed agent's `ask` while the developer never answers and the plugin restarts: the question is gone from its view and no answer reaches a dead handler. → Task 10, test "a restarted agent's open question is withdrawn".

---

### Task 1: Rename `plugin-rehearse` to `agent-rehearse`

**Files:** `git mv packages/plugin-rehearse packages/agent-rehearse`; modify `packages/agent-rehearse/package.json` (name), `packages/plugin/scripts/build-plugins.ts` (FIRST_PARTY), root `mise.toml` (`calibrate:rehearse` path), `AGENTS.md`, `packages/plugin/test/import-rule.test.ts`, `packages/core/test/plugins-helper.ts` (`grantFirstParty` path), any `plugin-rehearse` string (`grep -rn "plugin-rehearse" packages mise.toml AGENTS.md docs/superpowers/specs/2026-09-27-agents-tiled-shell-design.md`).

- [ ] **Step 1:** `git mv packages/plugin-rehearse packages/agent-rehearse`; set `"name": "@zarg/agent-rehearse"`; replace every `plugin-rehearse` path/name found by the grep with `agent-rehearse` (the plugin's manifest `name: "rehearse"` is unchanged).
- [ ] **Step 2:** In `import-rule.test.ts`, the plugin list becomes every package starting `plugin-` or `agent-` except `plugin-sdk`:
```ts
  const plugins = readdirSync(root).filter((p) => (p.startsWith("plugin-") || p.startsWith("agent-")) && p !== "plugin-sdk")
```
- [ ] **Step 3:** `mise x -- bun install`; `mise run -q build:plugins`; `mise run verify`. Expected: PASS, same counts.
- [ ] **Step 4:** Commit `refactor: rehearse is agent-rehearse`.

### Task 2: `@zarg/agent-host`: the thread, host and trusted-agent contracts

**Files:** Create `packages/agent-host/{package.json,mise.toml,tsconfig.json,src/index.ts}`; test `packages/agent-host/test/contract.test.ts`; modify `packages/core/src/thread.ts` (declare it returns `Thread`), `packages/core/src/server.ts` and `reconcile.ts` (import `Thread` from `@zarg/agent-host`).

**Interfaces — Produces:**
```ts
// packages/agent-host/src/index.ts
import type { Effect, Stream } from "effect"
import type { WireEvent } from "@zarg/client"
import type { Answer, Question } from "@zarg/rlm"

export interface RunInput {
  readonly runId: string
  readonly messages?: ReadonlyArray<{ readonly role: "user"; readonly content: string }>
  readonly resume?: ReadonlyArray<{ readonly interruptId: string; readonly payload?: unknown }>
}
/** A conversation thread the core serves (`/runs`, `/threads/:id/stop`). */
export interface Thread {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly run: (input: RunInput) => Stream.Stream<WireEvent>
  readonly wake: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
  /** Ask the developer on this thread from outside the agent (grant questions); answered in order. */
  readonly ask: (q: Question) => Effect.Effect<Answer>
  readonly status: () => "idle" | "running" | "waiting"
}
/** What the core gives a trusted agent. Values are the core's own services, typed loosely here to keep this package light. */
export interface AgentHost {
  readonly root: string
  readonly roles: Readonly<Record<string, string>>
  readonly rlmSettings: unknown
  readonly model: unknown
  readonly decisions: unknown
  readonly plugins: unknown
  readonly store: unknown
  readonly log: unknown
  readonly sensitive: ReadonlyArray<unknown>
  /** Agenda for the driver (reconcile's items and plugins' items, the host's own plugin-* items left out). */
  readonly agenda: (focus: ReadonlySet<string> | undefined) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly title: string; readonly detail: string; readonly about: ReadonlyArray<string>; readonly priority: number; readonly plugin?: string }>, unknown>
  /** Activity and views for RLM runs on a thread (the core's makeActivity with the thread's ViewStore). */
  readonly activity: (threadId: string) => unknown
  readonly outsideReads: (ask: (q: Question) => Effect.Effect<Answer, unknown>) => unknown
  readonly findings: { readonly chosen: unknown; readonly firstParty: (plugin: string) => boolean }
  readonly attention: (threadId: string, agent: string, reason: string | undefined) => void
}
/** A trusted agent: imported into the core, started once. */
export interface TrustedAgent {
  readonly name: string
  readonly start: (host: AgentHost) => Effect.Effect<{ readonly makeThread: (id: string, focus: ReadonlyArray<string>) => Effect.Effect<Thread> }, unknown>
}
export const defineTrustedAgent = (a: TrustedAgent): TrustedAgent => a
```
`agent-zarg` casts the `unknown` members to the concrete types it imports itself (`@zarg/model`, `@zarg/plugin/server`, `@zarg/graph`, the core's log type via `@zarg/agent-host`'s `ThreadLog` re-export is not needed: agent-zarg imports `ThreadLog` from `@zarg/core`? No — see Task 3 Ruling note: agent-zarg may import types only from `@zarg/core` (the type-only import rule below)).

- [ ] **Step 1: Test.** `contract.test.ts` checks `makeThread` from `@zarg/core` is assignable to `Thread` at compile time and that `defineTrustedAgent` returns its argument:
```ts
import { expect, test } from "bun:test"
import type { Thread } from "../src"
import { defineTrustedAgent } from "../src"
import type { makeThread } from "@zarg/core"
import type { Effect } from "effect"

type Made = Effect.Success<ReturnType<typeof makeThread>>
const assignable: Thread = null as unknown as Made
void assignable
test("a trusted agent is its own definition", () => {
  const a = defineTrustedAgent({ name: "x", start: () => null as never })
  expect(a.name).toBe("x")
})
```
(`@zarg/core` is a devDependency of `agent-host` for this test only.)
- [ ] **Step 2:** Run `mise //packages/agent-host:test` — FAIL (no src).
- [ ] **Step 3:** Write `src/index.ts` as above; `package.json` (`@zarg/agent-host`, deps `effect`, `@zarg/client`, `@zarg/rlm`; devDeps `@zarg/core`); mise.toml and tsconfig as other packages. In core: `thread.ts` ends with `export type { Thread } from "@zarg/agent-host"` replacing the inferred type, and `makeThread` is annotated `Effect.Effect<Thread>`; `server.ts` and `reconcile.ts` import `type Thread` from `@zarg/agent-host`.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat: @zarg/agent-host: thread, host and trusted-agent contracts`.

### Task 3: `agent-zarg`: the driver leaves the core

**Files:**
- Create `packages/agent-zarg/{package.json,mise.toml,tsconfig.json,bunfig.toml,src/index.ts}`.
- `git mv` from `packages/core/src` to `packages/agent-zarg/src`: `thread.ts`, `threads.ts`, `driver.ts`, `gaps.ts`, `intent.ts`; split `findings.ts`: `findingsService`, `FindingsDef`, `commitGraph` move to `agent-zarg/src/findings.ts`; `chosenFindings` stays in `core/src/chosen.ts`.
- `git mv` their tests from `packages/core/test` to `packages/agent-zarg/test`: `thread.test.ts`, `driver.test.ts`, `gaps.test.ts`, `intent.test.ts`, `findings.test.ts`, `agenda-text.test.ts`, `robust.test.ts` (fix imports).
- Modify `packages/core/src/live.ts` (build `AgentHost`, load and start trusted agents), `packages/core/src/index.ts` (drop moved exports), `packages/core/src/plugins.ts` (`trustedAgents(zargRoot)`).
- Test: `packages/core/test/trusted.test.ts`.

**Interfaces:**
- Consumes: `TrustedAgent`, `AgentHost`, `Thread` (Task 2).
- Produces: `packages/agent-zarg/src/index.ts` default export `defineTrustedAgent({ name: "zarg", start })`; `start(host)` builds `makeRlm` (the body of today's `live.ts` `makeRlm`, with `host.*` in place of the closure values), `whatNext`, `suggest`, `render`, and returns `{ makeThread: (id, focus) => makeThread({ id, focus, log, agenda: host.agenda, render, suggest, whatNext, driver }) }`. Core: `trustedAgents(zargRoot): Effect<ReadonlyArray<TrustedAgent>>` imports `packages/agent-*/src/index.ts` whose `package.json` has `"zarg": { "runtime": "trusted" }`, by absolute path under zargRoot.

**Rulings to ledger:** trusted agents are loaded by path from zarg's own `packages/` (first-party by location), not as hash-checked Bun bundles — the kernel needs `worker.ts` beside it and `typescript5` resolvable, which a single bundle cannot give; cost: a trusted agent is as trusted as zarg's checkout. `agent-zarg` may import `@zarg/core` for types only (`import type`); the core never imports `agent-zarg`.

- [ ] **Step 1: Test first.** `packages/core/test/trusted.test.ts`:
```ts
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { trustedAgents } from "../src/plugins"
import { ZARG_ROOT } from "../src/plugins"

test("zarg's own trusted agents are found in its packages and loaded by path", async () => {
  const agents = await Effect.runPromise(trustedAgents(ZARG_ROOT))
  expect(agents.map((a) => a.name)).toEqual(["zarg"])
})
```
and in `process.test.ts` a case: `"without agent-zarg the core serves and main says why"` — start the core with env `ZARG_TRUSTED_AGENTS=none` (a test-only switch read by `trustedAgents`), post a run on `main`, and expect a `TEXT_MESSAGE_CONTENT` starting `zarg is not loaded:`.
- [ ] **Step 2:** Run both — FAIL.
- [ ] **Step 3:** Create the package, move the files (`git mv`), fix imports: moved files import `ThreadLog`, `E` (events), `makeActivity`, `threadViews`, `AgendaItem` via `import type` from `@zarg/core` or receive them through `AgentHost` (`host.log`, `host.activity(threadId)`). Write `src/index.ts`:
```ts
import { Effect } from "effect"
import { defineTrustedAgent, type AgentHost } from "@zarg/agent-host"
import { makeZarg } from "./zarg"
export default defineTrustedAgent({ name: "zarg", start: (host: AgentHost) => makeZarg(host) })
```
`src/zarg.ts` holds `makeZarg`: today's `live.ts` lines building `makeRlm`, `render`, `suggest`, `whatNext` and the `makeThreads`-equivalent `makeThread` factory, taking every value from `host`.
In core `plugins.ts`:
```ts
/** zarg's own trusted agents: packages under zarg's packages/ that say `"zarg": { "runtime": "trusted" }`, imported by path. */
export const trustedAgents = (zargRoot: string) =>
  Effect.promise(async () => {
    if (process.env.ZARG_TRUSTED_AGENTS === "none") return []
    const dir = join(zargRoot, "packages")
    const found = readdirSync(dir).filter((p) => p.startsWith("agent-") && existsSync(join(dir, p, "package.json")) && JSON.parse(readFileSync(join(dir, p, "package.json"), "utf8")).zarg?.runtime === "trusted")
    const mods = await Promise.all(found.map((p) => import(join(dir, p, "src", "index.ts"))))
    return mods.map((m) => m.default as TrustedAgent)
  })
```
In `live.ts`: build `AgentHost` from the existing values (`root`, `roles`, `rlmSettings`, `model`, `decisions`, `host`, `store`, `log`, `sensitive`, `agenda`, `activity: (t) => makeActivity(log, t, undefined, threadViews(log, t))`, `outsideReads: (ask) => outsideReads({ grants: agentGrants, userDir: USER_DIR, ask, yolo: () => yoloControl.on("zarg:agents") })`, `findings: { chosen, firstParty: control.firstParty }`, `attention` from Task 6 — a no-op until then). Start `zarg`; `makeThreads` takes `makeThread` from it; when `trustedAgents` is empty or `start` fails, `main` is a stand-in `Thread` whose `run` emits one message `zarg is not loaded: <reason>` and finishes.
`agent-zarg/package.json`: `{ "name": "@zarg/agent-zarg", "zarg": { "runtime": "trusted" }, "dependencies": { "@zarg/agent-host", "@zarg/rlm", "@zarg/kernel", "@zarg/model", "@zarg/decisions", "@zarg/graph", "@zarg/plugin", "@zarg/view", "@ag-ui/core", "effect" }, "devDependencies": { "@zarg/core", "@effect/platform-bun" } }` (all `workspace:*` / the repo's versions).
- [ ] **Step 4:** `mise run verify` — PASS; the moved tests pass from `agent-zarg`.
- [ ] **Step 5:** Commit `feat: zarg is a trusted agent plugin; the driver leaves the core`.

### Task 4: The `conversation` section kind (`@zarg/view`)

**Files:** modify `packages/view/src/schema.ts`, create `packages/view/src/conversation.ts`, test `packages/view/test/conversation.test.ts`; `packages/view/src/index.ts`.

**Interfaces — Produces:** `ConversationData` schema; `ConversationUi { pick: number; other: boolean; chatting?: string; answered?: string; questionId?: string }`; `conversationRows(q, ui)` → rows `{ id, label, why?, recommended, selected }` (OTHER `"__other"`, CHAT `"__chat"`; grant questions only their options); `syncConversation(ui, q)` (new question → preselect recommended); `conversationKey(ui, q, key)` → `{ ui, answer?: { choice } | undefined }` for up/down/return/escape; `conversationSubmit(ui, q, text)` → `{ ui, answer?: { other } }` or `{ ui, send: text }`.

- [ ] **Step 1: Test** — port the picker tests from `packages/view-tui/test/view.test.ts` (`describe("picker")` and the grant-question test) to `conversation.test.ts` against the new functions, plus: schema round trip of a `conversation` datum.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Add `conversation` to `DATA` (`ConversationData = Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.Literals(["user","agent"]), text: Schema.String })), question: Schema.optionalKey(QuestionSchema), status: Schema.optionalKey(Schema.Literals(["idle","working","waiting"])) })`), `LeafKind` gains `"conversation"`; move the picker logic (`pickerRows`, `preselect`, the picker branch of `onKey`, the answering branch of `onSubmit`) from `view-tui/src/view.ts` into `conversation.ts`, typed by the question shape (no `SessionState`). `renderers` in view-tui must now draw `conversation` (Task 7) — until then add a placeholder renderer that prints the messages (keeps typecheck green).
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat(view): the conversation section kind and its behaviour`.

### Task 5: Attention on agent rows

**Files:** `packages/plugin-sdk/src/services.ts` (`Attention`), `packages/core/src/plugin-agents.ts` (event `attention`), `packages/core/src/activity.ts` (`attention` on rows; `closeStale` drops it), `packages/client/src/state.ts` (`RlmNode.attention`), core `live.ts` (`AgentHost.attention`), tests in `packages/core/test/plugin-agents.test.ts`, `packages/core/test/restart.test.ts`, `packages/plugin-sdk/test/views.test.ts`.

**Interfaces — Produces:** SDK `Attention.of({ request: (agent, reason) => …, clear: (agent) => … })` over `agents.event` `{ event: "attention", id, reason?: string }`; row field `attention?: { reason: string; since: number }`; `AgentHost.attention(threadId, agent, reason | undefined)`.

- [ ] **Step 1: Tests:** a plugin agent's attention appears on its row with its reason and clears; `closeStale` leaves no attention on stopped rows (Review Focus 4: also an agent's `end` clears attention).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement: `pluginAgents` maps `attention` to `a.observe({ type: "status", id, attention })`; `makeActivity`'s status branch merges `attention` (undefined removes it); `end` removes it; `closeStale` sets `attention` undefined on rows it stops. Client `RlmNode` gains `attention?: { reason: string; since: number }`.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat: agents ask for attention on their rows`.

### Task 6: zarg's row and rehearse's testers ask for attention

**Files:** `packages/agent-zarg/src/zarg.ts` (a `zarg` row on `main`, parent of the driver's root RLMs; attention while a question waits), `packages/agent-rehearse/src/run.ts` and `index.ts` (testers request/clear), tests `packages/agent-zarg/test/zarg-row.test.ts`, `packages/agent-rehearse/test/run.test.ts`.

- [ ] **Step 1: Tests:** on `main`, the activity stream has a `zarg` row (preset `zarg`) and the driver's root RLM has parent `zarg`; while the thread waits on a question the `zarg` row has attention `asks: <question>`; answering clears it. Rehearse: a finished run with open findings requests `N findings to review` on each tester with findings; applying or dismissing the last clears it; "attention clears when the agent ends and on a core restart".
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement: `makeZarg` wraps `observe` so a root RLM (`parent` undefined) gets `parent: "zarg"`; emits the `zarg` row once per thread (`start` with preset `zarg`); `askAs` calls `host.attention(threadId, "zarg", "asks: " + shorten(question))` when the question is shown and `host.attention(threadId, "zarg", undefined)` when answered. Rehearse: `refresh` computes per tester the open (not dismissed, not resolved) findings and calls `Attention.request` / `clear`.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat: zarg and rehearse's testers ask for attention`.

### Task 7: The conversation renderer; zarg's tile built from thread state

**Files:** `packages/client/src/zarg-view.ts` (new: `zargConversation(thread): ViewState`), `packages/view-tui/src/conversation.tsx` (new: the renderer: messages, then the question or the message input with the slash box and the Something else line), `packages/view-tui/src/view.ts` and `app.tsx` (use it; the old picker/message code removed), tests `packages/client/test/zarg-view.test.ts`, `packages/view-tui/test/conversation.test.tsx`, updated `app.test.tsx`.

**Interfaces — Produces:** `zargConversation(thread: ThreadState): ViewState` with one `conversation` section `talk` (role `primary`); `ConversationTile(props: { view: ViewState; ui: ConversationUi; focused: boolean; onAnswer; onSend; onCommand })`.

- [ ] **Step 1: Tests:** client — messages map to `role`, the pending inquiry to `question`, run status to `status`; view-tui — with a question the slot shows the options and no input; without, the input; "Chat about this" swaps to the input; grant questions show only options; slash box appears in the input.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; `app.tsx` renders `ConversationTile` for zarg (Task 8 places it in its tile; here it replaces the conversation column).
- [ ] **Step 4:** `mise run verify` — PASS (app tests updated for the new layout text).
- [ ] **Step 5:** Commit `feat(tui): zarg's conversation is a conversation section`.

### Task 8: The tiled shell

**Files:** `packages/view-tui/src/tiles.ts` (new: tile model), `packages/view-tui/src/app.tsx`, `packages/view-tui/src/view.ts` (`Ui.tile: "zarg" | "view" | "agents"`; Alt+arrows; Enter on a row opens it in the view tile), tests `packages/view-tui/test/tiles.test.ts`, `app.test.tsx`.

**Interfaces — Produces:** `layoutOf(width): "wide" | "narrow"` (narrow below 100); `nextTile(ui, dir: "left" | "right" | "up" | "down", layout, viewOpen): Ui["tile"]`; the key handler routes keys to the focused tile only.

- [ ] **Step 1: Tests:** wide frame 130×22 shows three tiles side by side; narrow 80×24 stacks zarg above the view with the strip (Review Focus 3: "at 80×24 zarg is above the view and the strip lists attention"); Alt+right from zarg focuses the view, Alt+right again the agents; "a question waits while the view tile has focus: arrows move the view" (Review Focus 2); Escape in the view tile closes the view and focuses zarg.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement: opentui gives Alt as `key.meta` (`option` on some terminals — accept both `meta` and `option`); `Key` gains `meta`; `onKey` checks `(key.meta) && ["left","right","up","down"].includes(key.name)` first. The `viewing` field stays (the open agent); `tile` decides key routing.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat(tui): a tiled shell: zarg, the open agent, the agents tree`.

### Task 9: Attention in the shell

**Files:** `packages/view-tui/src/view.ts` (`agentRows` shows ◆ and the reason; `attentionOf(rlms)` ordered list; status line; `g`), `app.tsx` (tree title `Agents ◆N`), tests in `view.test.ts` and `app.test.tsx`.

- [ ] **Step 1: Tests:** a row with attention reads `◆ <preset> <id>  <reason>`; the count; the status line lists the first two reasons; `g` opens the next one (zarg first; wraps).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat(tui): attention in the tree, the title and the status line; g opens the next`.

### Task 10: Conversations for sandboxed agents

**Files:** `packages/plugin-sdk/src/services.ts` (`Conversation`), `packages/plugin-sdk/src/define.ts` (the SDK keeps each agent's open `ask` and resolves it on `answer`), `packages/core/src/server.ts` (`POST /threads/:id/agents/:agent/messages {text}`, `POST …/answers {question, answer}`), `packages/core/src/actions.ts` (route to the plugin's `message` / `answer`), `packages/client` (`message`, `answer` on an agent), `packages/view-tui` (the view tile draws a plugin agent's `conversation` section with `ConversationTile`, sending through them), tests in each package.

- [ ] **Step 1: Tests:** a fixture plugin agent with a `conversation` section: `ask` shows the question in its view; the developer's answer (HTTP) completes `ask`; `message` reaches its `message` method; "a restarted agent's open question is withdrawn" (Review Focus 5: after a restart the view's `question` is cleared by the SDK on start).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `mise run verify` — PASS.
- [ ] **Step 5:** Commit `feat: sandboxed agents can hold a conversation`.

### Task 11: Docs and cleanup

- [ ] `AGENTS.md`: packages list (`agent-host`, `agent-zarg`, `agent-rehearse`; archetypes and runtimes; the tiled shell's keys); delete `packages/view-tui/mockups/`; `mise run verify`; commit `docs: agents, runtimes and the tiled shell`.

## Self-review notes

- Spec coverage: runtimes and contract (Tasks 2–3), packages and naming (1, 3), conversation kind (4, 7, 10), attention (5, 6, 9), tiled shell (8, 9), errors (3: agent-zarg missing; 5: attention clean-up), testing sections mapped per task.
- Deviations to ledger at execution: trusted agents loaded by path, not as hash-checked bundles (Task 3); `activity.ts` and `rlm-view.ts` stay in the core (reconcile uses them) and reach `agent-zarg` through `AgentHost.activity`; the spec listed them as moving.
