# The inbox: zarg's home, one topic per thing that needs the operator

Date: 2026-09-29 · Status: approved direction (option B of `2026-09-29-decision-inbox-mock.md`), pending spec review

This is spec 1 of 4:
1. **This spec:** the inbox core (model, store, power, priority, home and topic views).
2. Move the blocking kinds onto it: grants, then zarg's questions as topics.
3. Move the waiting kinds and reports: backlog `needs`, reconcile findings, disabled plugins, rehearse "ask", run reports.
4. Sync: rehearse with code evidence, and the `drift` kind. It builds on `2026-09-29-card-code-audit-design.md`, which is done.

## Problem

zarg asks the operator for things in 18 places, each with its own surface, transport and lifecycle (inventory in the mock). Nothing shows how many decisions wait, which ones block an agent, or where each came from. Some never reach the screen: disabled plugins, reconcile findings unless zarg turns them into a question.

## Outcome

- **The home screen is a priority-sorted inbox of topics.** A topic is one thing that wants the operator: a question, a decision, a finding or a report. It carries its evidence, its messages and, when there is one, its decision.
- **Answering is the same everywhere:** a number, a reason with `t`, or a batch.
- **Agents' views stay one key away** for watching and acting. They stop being where you must go to notice things.

## Words

- **Topic:** one inbox item. The word "thread" stays for the core's AG-UI run threads (`main`, `plan`, `implement`); the UI may call a topic a thread.
- **Decision:** a topic's answers, when it has them.
- **Blocking:** a caller waits for the answer.

## Model

```ts
type Topic = {
  id: string                                  // T-<8 hex>, stable
  kind: string                                // grant | question | drift | plan | finding | plugin | report | …
  from: { plugin: string; agent?: string }
  title: string                               // one line: the question or the news
  why: string                                 // the reason label: "blocks triage-2", "plan B-12 can't apply"
  about: ReadonlyArray<string>                // entity refs (cards, plans, feedback)
  blocking: boolean
  severity?: "high" | "medium" | "low"
  answers?: ReadonlyArray<{ id: string; label: string; recommended?: boolean; why?: string; reason?: "optional" | "required" }>
  text?: { placeholder: string }              // an answer of your own
  evidence?: string                           // markdown
  origin?: { view: string; row?: string }     // where `o` jumps
  messages: ReadonlyArray<{ by: string; at: number; text: string }>
  state: "open" | "answered" | "moot" | "read"   // read: a report once opened
  answer?: { id?: string; text?: string; by: string; at: number }
  moot?: string                               // why it stopped mattering
  snoozed?: { until: "change" }               // non-blocking only
  created: number
  updated: number
}
```

## Core

- **An `Inbox` service** in `packages/core/src/inbox.ts`. It holds one file per topic under `.zarg/inbox/<id>.json`, which is gitignored as operator state. On start it loads them, and it drops `answered`, `moot` and `read` topics older than 7 days.
- **Events:** every change logs `zarg.inbox` `{ topic }` on the `main` thread, as prompts do today. On start, one `zarg.inbox` event goes out per open topic.
- **Endpoints:**
  - `POST /inbox/:id/answer {answer?, text?}` answers a topic. It fails when the topic is not open, when the answer isn't one it offers, or when a `required` reason is missing.
  - `POST /inbox/answer {ids, answer, text?}` answers a batch, only for topics of one kind that all offer that answer.
  - `POST /inbox/:id/snooze` and `POST /inbox/:id/read`. A blocking topic refuses snooze.
- **Blocking topics never expire by default.** An asker may pass its own deadline. A future settings feature, where plugins register settings as VS Code extensions do, can expose one.

**Priority** is computed in one place, `priorityOf(topic, now)`, never by plugins:
1. Blocking.
2. Open with answers: needs you.
3. Open without answers, by severity.
4. Reports.

Within a tier, older first. A snoozed topic sorts last until it changes.

## The plugin power `Inbox` (`@zarg/plugin-sdk`)

```ts
Inbox.ask(topic)              // blocking: parks the caller until an answer; returns { answer?, text? }
Inbox.post(topic)             // not blocking: returns the id; an answer comes to the plugin's `answered` method
Inbox.settle(id, why)         // the topic stopped mattering at the source: it becomes moot with the reason
Inbox.update(id, patch)       // new evidence, title or messages; wakes a snoozed topic
```

- **Scope:** `inbox: true` in the plugin's scopes. First-party plugins declare it.
- **Namespacing:** topics are namespaced by plugin, so a plugin can settle and update only its own.
- **Answers to a `post`:** they reach the plugin through a contract method it defines, `answered({ id, answer, text })`, which plugins with `inbox` implement.
- **The core itself** raises topics through the same service, for example disabled plugins.

## Client (`@zarg/client`)

- **`ThreadState.inbox`:** a map of topics, fed by `zarg.inbox` events. It is kept like `prompts`, from `main`'s events, whatever thread the session is on.
- **Session methods:** `answer(id, answer?, text?)`, `answerMany(ids, answer, text?)`, `snooze(id)` and `read(id)`.

## TUI (`@zarg/view-tui`)

- **Home:** the new `Main` value `"inbox"` is the home on arrival, in place of the grid. `goHome` goes to the inbox. The grid of agent cards stays one entry away: `^k agents`.
- **Rail:** it keeps the agents, with `Inbox <n>` at the top of the VIEWS band. Its ◆ shows while something blocks.
- **Inbox view (mock frame 6):** one sorted list; the glyph says blocking (◆), needs you (◇) or report (·).
  - Each row shows who asks, the title, the kind with a hint ("grant · waiting", "3 options", "drift · 2 replies") and the age.
  - `a` toggles showing answered, moot and read topics.
  - `/` searches (BM25 over title, why and evidence, as tables do).
- **Topic view (mock frame 7):** Enter opens a topic. It shows the title line, the evidence, the messages, then the answers as numbered buttons.
  - `1-9` answers; `t` answers with a reason, or with your own text.
  - `o` opens the origin view; `z` snoozes (not on blocking topics); Esc goes back.
- **Batch:** in the inbox, `space` marks topics of the same kind. A number then answers every marked topic with that answer, if they all offer it. The count shows in the status line.
- **Anywhere:**
  - The status line shows `◆ <n> blocking · <m> open` when there are any.
  - `g` goes to the next blocking topic (before agents asking for attention, as today).
  - A new blocking topic makes ◆ blink on the rail's Inbox row until seen.

## The first source: disabled plugins

So the inbox is useful from day one, the host's `plugin-disabled` / `plugin-failed` / `plugin-needs` agenda items also post a `plugin` topic. They have no TUI surface today.

- **Answers:** none. The host cannot restart one plugin, so the topic says to restart zarg; it is read once opened.
- **Settles when:** the plugin loads again.

Grants, zarg's questions and the rest move onto the inbox in specs 2 and 3.

## Errors

- An answer to a topic that is not open: 409, with the topic's state.
- A plugin's `ask` whose caller is interrupted (a stop, a restart): the topic becomes moot, "the asker stopped".
- A corrupt topic file: skipped, and reported once as a `report` topic from the core.

## Tests

- **Core `inbox`:**
  - store and load;
  - `priorityOf` (tiers, age, snoozed last);
  - answer validation (a missing required reason, an unknown answer);
  - batch (same kind, answer offered by all);
  - snooze refused on blocking topics, and woken by an update;
  - moot on settle;
  - an interrupted asker leaves a moot topic;
  - the 7-day drop.
- **Power:** a sandboxed plugin's `Inbox.ask` resolves with the operator's answer; `post` plus `answered` reaches the plugin; a plugin cannot settle another's topic.
- **Client:** `zarg.inbox` events reduce into `inbox`; the session methods post.
- **TUI:**
  - the inbox is home and sorted;
  - the topic view's numbers answer, `t` sends text, `z` is refused on blocking topics;
  - batch marking;
  - the status line counts;
  - `g` reaches a blocking topic.
- **Source:** a disabled plugin posts a `plugin` topic, and loading again settles it.
