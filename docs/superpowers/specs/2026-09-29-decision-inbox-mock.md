# The inbox: zarg's home, one thread per thing that needs you

Date: 2026-09-29 · Status: design mock, for review

## Why

zarg asks the operator for things in 18 places today. Each one has its own surface, transport and lifecycle:

- **Blocking questions** park a caller until you answer:
  - grant popovers, which deny after 10 minutes;
  - zarg's questions, shown in the bar, one at a time;
  - `Conversation.ask`.
- **Waiting on you** is the rest, where work is skipped until you act:
  - backlog `needs`, Resync, moving plans to Ready;
  - reconcile findings, which appear only if zarg turns them into a question;
  - disabled plugins, which appear on no TUI surface at all;
  - rehearse's "ask" route, which is lost as a plain `on`.
- **Coming next:** the drift choice (card or code).

Nothing shows how many decisions wait, which ones block an agent, or where each came from. Prior art warns against exactly that: in Cursor, runs "timed out waiting for approval" that the operator never saw.

## Prior art we borrow from

| Idea | From |
|---|---|
| Each item declares which answers it accepts (accept, edit, respond, ignore) | [LangChain Agent Inbox](https://github.com/langchain-ai/agent-inbox) |
| The answer resumes exactly the call that waits | [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| A "no" can carry a reason back to the agent | [Claude Code permissions](https://code.claude.com/docs/en/permissions), [HumanLayer](https://www.npmjs.com/package/@humanlayer/sdk) |
| Number keys pick an answer; one key defers | [Linear Triage](https://linear.app/docs/triage), [Superhuman](https://blog.superhuman.com/inbox-zero-in-7-steps/) |
| A reason label on every item ("review requested") | [GitHub notifications](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications) |
| Acting at the source clears the item | [GitLab To-Do](https://docs.gitlab.com/user/todos/) |
| Snooze until something changes, not only until a time | [Linear Inbox](https://linear.app/docs/inbox), [Sentry](https://docs.sentry.io/product/issues/states-triage/) |
| Urgency splits; an unanswered deferral comes back | [PagerDuty](https://support.pagerduty.com/main/docs/incidents) |
| A list with a preview beside it, and the keys always in sight | [gh-dash](https://github.com/dlvhdr/gh-dash), [k9s](https://k9scli.io/topics/commands/) |

Avoid:
- **A read/unread state.** A decision is pending or answered, nothing else.
- **Making decisions in another tool.** The evidence sits beside the item.
- **Items that vanish without a word.** One that no longer matters says why ("the card changed").

## The model

```ts
type Decision = {
  id: string
  from: { plugin: string; agent?: string }   // who asks
  title: string                              // the question, one line
  why: string                                // the reason label: "blocks triage-2", "plan B-12 can't apply"
  about: ReadonlyArray<string>               // entity refs: cards, plans, feedback
  blocking: boolean                          // a caller waits for the answer
  answers: ReadonlyArray<{ id: string; label: string; recommended?: boolean; why?: string; reason?: "optional" | "required" }>
  text?: { placeholder: string }             // an answer of your own
  evidence?: string                          // markdown: card vs code, the diff, the scopes asked for
  origin?: { view: string; row?: string }    // where o jumps
  expires?: number                           // grants: deny at this time
  state: "pending" | "answered" | "moot"     // moot: it stopped mattering, with the reason
}
```

A plugin raises one with a new power, `Inbox`:
- **`Inbox.ask(decision)` blocks and returns the answer.** Grants, `Conversation.ask` and zarg's Inquire move onto it.
- **`Inbox.post(decision)` does not block.** The plugin calls `Inbox.settle(id, why)` when the state changes at the source: the plan was dropped, the card changed, the finding cleared.

Every answer goes through one endpoint, `POST /decisions/:id {answer, text?}`. Today's endpoints for prompts, runs, answers and actions stay as the ways each source is fed.

## The view

Decisions is a nav item above the agents, like Feedback and Backlog. It shows the count of pending decisions, and ◆ when one blocks. The list is on the left, grouped by urgency. The highlighted decision shows beside it, with its answers as numbered buttons.

### 1. The inbox, on a drift choice

```
 zarg                        Decisions                                                              ◆ 2 blocking · 5 waiting
 ◆ Decisions   7          ─────────────────────────────────────────────────────────────────────────────────────────────────
   Feedback   12            BLOCKING NOW                                   │ Card or code?  UX-0044 Operator stops an agent
   Backlog     4          ◆ grant  backlog wants to write .zarg/triage  8m │ drift · rehearse t-3 · Watch agents · 2 feedback
 ─────────────────          ◆ zarg   Which journey next?                   │
 ● zarg                                                                    │  1  Reword the card to match the code
   ⠼ rehearse               WAITING ON YOU                                 │  2  Change the code to match the card   (recommended)
     tester-1             › ◇ drift  UX-0044 card or code?        rehearse │  3  Not sure: talk it over with zarg
     tester-2               ◇ drift  UX-0042 card or code?        rehearse │
   ○ triage                 ◇ plan   B-12 can't apply: graph dirty  backlog│  The card says
   ○ backlog                ◇ finding UX-0023 verify keeps failing  reconc.│    When  the operator stops an agent
                            ◇ plugin provider-x disabled (3 crashes) host  │    Then  the agent stops with all its children
                                                                           │
                            ANSWERED TODAY                                 │  The code does                     view-tui/src/layers.ts:147
                            ✓ grant  triage: decisions scope  Always  2h   │    Ctrl-C stops the whole thread's run; no one agent
                            ✓ drift  UX-0046 → card reworded       B-14    │    can be stopped (core/src/server.ts:243)
                                                                           │
                                                                           │  Rewording the card  B-15 (drafted, dry-run ✓)
                                                                           │  - When  the operator stops an agent
                                                                           │  + When  the operator stops the run
                                                                           │  Changing the code   B-16 (code plan, reconcile)
 ─────────────────                                                         │
 ↑↓ move  1-3 answer  t answer + reason  o open origin  z snooze until it changes  / search  Esc back
```

- **Groups:** Blocking now (a caller waits), Waiting on you (work is skipped until you act), and Answered today (a trail of what you decided, as in GitHub's Done tab).
- **Rows:** kind, the item it is about, the question, and who asks, in the style of GitHub's reason labels.
- **Grants:** they show their time left ("8m") and deny on their own at 0, as today.
- **Answers:** a number answers. `t` answers with a reason ("no, because …"), and the reason goes back to the agent. `o` jumps to the origin: the Feedback entry, the plan's drawer, or the agent's view.
- **Snooze:** `z` snoozes until the item changes. It works only on non-blocking items; a blocking one comes back.

### 2. A grant, in the same place

```
                            BLOCKING NOW                                   │ backlog wants to write .zarg/triage/**      8m left
                          › ◆ grant  backlog wants to write .zarg/triage  8m │ grant · plugin-backlog · fs write
                            ◆ zarg   Which journey next?                   │
                                                                           │  1  Allow once
                                                                           │  2  Always allow  (saved in ~/.config/zarg/grants.json)
                                                                           │  3  Deny           (t: deny with a reason)
                                                                           │
                                                                           │  Why it asks: Refine saves the journey's round to
                                                                           │  .zarg/triage/set-up-85fbc4.json
                                                                           │  Declared in its manifest: fs write .zarg/triage/**
```

The popover stays for blocking items that expire (grants), since you shouldn't miss those. Answering in either place settles both, as GitLab's resolve-at-source does. Every other kind of decision lives only in the inbox.

### 3. zarg's question, not just in the bar

```
                            BLOCKING NOW                                   │ Which journey next?                  zarg · driver
                            ◆ grant  backlog wants to write …          8m │ the agenda is empty · 3 gaps found
                          › ◆ zarg   Which journey next?                   │
                                                                           │  1  Watch agents: stop one agent   (recommended)
                                                                           │     4 drifts filed against it
                                                                           │  2  Set up: provider login          13 cards planned
                                                                           │  3  Talk with zarg: merge conflicts
                                                                           │  4  Something else…            (t: your own answer)
```

zarg's bar still shows its head question: "◆ zarg asks … (1 of 2)". The inbox shows every question in zarg's queue, not just the head.

### 4. Anywhere else in zarg

```
 ↑↓ pick  Enter open                        ◆ 2 blocking · 5 decisions   g next   ^d inbox        YOLO
```

- **The status line** always counts what waits.
- **`g`** jumps to the next blocking decision, as it jumps to the next agent asking for attention today.
- **`^d`** opens the inbox.
- **The agent that asks** gets ◆ in the rail, so a blocked agent is visible where you watch it.

### 5. A decision that stopped mattering

```
                            ANSWERED TODAY
                            ✓ drift  UX-0044 → code plan B-16             │ Card or code?  UX-0044                      moot
                            – plan   B-12 can't apply      moot: dropped  │ It stopped mattering: B-12 was dropped by the
                                                                          │ operator (backlog, 14:02). Nothing to answer.
```


## Option B: the inbox is zarg's home, and every item is a thread

Frames 1 to 5 add Decisions as one more nav view. This option goes further. The operator's main screen is a priority-sorted inbox, and everything that wants them is a **thread** in it:
- a decision;
- a zarg question;
- a finding;
- a finished run's report;
- a conversation the operator started.

Agents' views stay one keystroke away, for watching and for acting inside them. They stop being the place you must be to notice things.

What changes from today:

| Today | Inbox as home |
|---|---|
| Home is a grid of agent cards, with zarg's sheet over it | Home is the inbox, sorted by priority; the agents rail stays on the left |
| zarg is one long conversation (`main`), and its questions queue behind the bar | Every zarg question is its own thread. "Chat about this" is a reply in that thread. A message typed in the bar starts a new thread, or replies to the one open |
| Each surface asks in its own way (popovers, bar, drawer text, agenda) | Each asker opens or updates a thread: `Inbox.ask` / `post` / `settle`, plus `Inbox.say` for a message in a thread |
| You go to an agent to learn what it wants | Its thread comes to you; `o` opens the agent's view when you want the detail |

### 6. Home: the inbox

```
 zarg                        Inbox                                                                     ◆ 2 blocking · 9 open
 ▸ Inbox       9         ──────────────────────────────────────────────────────────────────────────────────────────────────
   Feedback   12           ◆ backlog     wants to write .zarg/triage/**                      grant · 8m left     now
   Backlog     4           ◆ zarg        Which journey next?                                  3 options           2m
 ─────────────────       › ◇ rehearse    UX-0044: card or code?                               drift · 2 replies   5m
 ● zarg                    ◇ reconcile   UX-0023 verify keeps failing after 2 fixes           finding             12m
   ⠼ rehearse              ◇ backlog     B-12 can't apply: the graph has uncommitted edits    plan                20m
     tester-1              ◇ zarg        "why does triage leave cards out?"                   you asked · answered 1h
     tester-2              · rehearse    Watch agents run done: 14 findings, 4 drifts         report              1h
   ○ triage                · triage      Set up folded into 3 plans: B-14, B-15, B-16         report              2h
   ○ backlog               · host        provider-x disabled after 3 crashes                  plugin              3h
 ─────────────────
 ↑↓ move  Enter open  1-9 answer  a all  / search  n new thread (to zarg)  g next blocking  o agent's view
```

The inbox sorts by priority:
1. **Blocking (◆):** a caller waits. An expiring grant comes first.
2. **Needs you (◇):** work is skipped until you act.
3. **Reports (·):** for your information. They leave the list once opened; `a` shows everything, answered and read.

### 7. A thread: the question, its evidence, the talk, the answer

```
 ← Inbox   UX-0044: card or code?                                        rehearse · Watch agents · drift · 5m
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  rehearse · tester-3                                                                                    5m
    The card says the operator stops one agent; the code only stops the whole run (Ctrl-C).
    ┌ card UX-0044 ───────────────────────────┐ ┌ code view-tui/src/layers.ts:147 ─────────────────────────┐
    │ When  the operator stops an agent       │ │ if (k.ctrl && k.name === "c") … { type: "stop" }         │
    │ Then  the agent stops with its children │ │ core/src/server.ts:243  POST /threads/:id/stop           │
    └─────────────────────────────────────────┘ └──────────────────────────────────────────────────────────┘
  triage                                                                                                 4m
    Drafted both: B-15 rewords the card (dry-run ✓); B-16 is a code plan for reconcile.
  you                                                                                                    2m
    Is stopping one agent hard to build?
  zarg                                                                                                   1m
    No: each RLM already has its own fiber (rlm.ts:199). A stop per agent is one endpoint and a key.

  1  Reword the card (B-15)      2  Change the code (B-16)  recommended      3  Leave both open
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 › reply to this thread…                                                              Enter send  1-3 answer  Esc back
```

- **A reply** goes to the thread. zarg answers inside it, with this thread's context: the card, the code and the drift, not the whole session.
- **A number** answers the decision. The thread closes, and stays in the "all" list as the record of why.
- **`o`** opens rehearse's run view, or the plan's drawer, for the detail.

### What it takes

- **Threads exist already:** `.zarg/threads/` and their logs, plus the AG-UI thread API. zarg's `main` thread becomes one thread per topic, and the core already serves several threads (plan, implement).
- **A thread is a topic plus messages from agents and the operator,** with an optional decision attached. The decision model above is unchanged.
- **zarg's driver works per thread:** the thread's context and the thread's question. This replaces one growing conversation, which is the drift the intent doc names.
- **Priority is computed in one place** from blocking, expiry, kind, severity and age. Plugins don't pick their own rank.
- **The grid of agent cards** stays as a view (`^k agents`), no longer the home.

## Where each of today's 18 decisions lands

| Today | In the inbox as | Blocking |
|---|---|---|
| Plugin power grants, plugin load grants, reads outside the repo | `grant`, with a popover as well | yes (expires) |
| zarg's Inquire (ask, confirm, choose) | `zarg` | yes |
| Plugin `Conversation.ask` | `question` | yes |
| Backlog `needs`, Resync, a plan waiting for Ready | `plan` | no |
| Reconcile findings (6 kinds) | `finding`: answers from the driver, or "talk it over with zarg" | no |
| Plugin disabled / failed / missing a dependency | `plugin`: Restart it or Remove it | no |
| Rehearse route "ask" (a product decision) | `question`: keep the entry on or off, with the tester's why | no |
| Triage left-out cards | `plan`: Draft again or Leave out | no |
| Drift (new) | `drift`: Reword card / Change code / Talk it over | no |
| Attention, YOLO, reconcile off | Not decisions: they stay as they are (◆, status line) | — |

## Recommendation

1. **Build the model and the view first** (`Inbox.ask/post/settle`, `POST /decisions/:id`, the nav view). Move grants and zarg's Inquire onto it; they block and they are the ones people miss.
2. **Then move the waiting kinds:** needs, findings, disabled plugins and rehearse "ask". Most are an `Inbox.post` where an agenda item or a text line is raised today.
3. **Drift arrives as a native kind,** so the sync design needs nothing of its own for the choice.

## Open questions

- **Do agenda items become decisions?** They are the driver's work list, not the operator's, but some are really the operator's (plugin disabled). My suggestion: only the ones that need a person. The driver keeps its agenda.
- **Snooze for blocking items:** never, or only while the caller has no deadline?
- **Batch answers** ("Always allow" for every grant from this plugin, "Reword card" for all 4 drifts in this journey)? Claude Code's "don't ask again" shows this cuts prompt fatigue.
