# Grants and zarg's questions in the inbox (spec 2 of 4)

Date: 2026-09-30 · Status: approved direction (the operator: "the happiest experience that doesn't end up broken"), written by the implementer on their behalf

## Outcome

- **Every question zarg or a plugin asks is an inbox topic,** the one record of truth. The popover and zarg's bar are views of it.
- **No answer is lost:** not to a restart, and not to zarg being busy or stopped.
- **One answer per topic:** answering in two places counts once; the other says "already answered".
- **The conversation stays as it is** (the bar and zarg's sheet). Making every message its own thread (2c) is deferred until topics have been lived with.

## 2a: grants

- **Grants are blocking topics.** The core's grant question (a plugin's optional scope, loading a plugin, an agent reading outside the repo) is a blocking topic of kind `grant`, from the plugin or from `zarg` (agents), with the grant options as answers.
  - The core's prompt queue keeps only plugin popovers (surfaces). Its grant `ask`/`answer` go.
- **The popover is a view of the topic.** Clients show the open grant topics as the popover queue (first raised, first shown, as today). Answering the popover answers the topic, and the inbox answers it too. Whichever comes first counts; the other gets its notice.
- **No expiry by default.** The 10-minute auto-deny goes: a grant waits until answered. `[plugins] grant_timeout = <seconds>` in the project config turns a deadline back on (a stand-in until plugins register settings).
- **Restarts:** a grant's caller dies with the core, so on start its topic is moot ("zarg restarted before it was answered"), as spec 1 does. The plugin asks again and one live grant shows.
- **Old logs:** `zarg.prompt` grant events in old logs still reduce, and the core's start withdraws any left open (`closeStale`).

## 2b: zarg's questions

- **Posting:** each `Inquire.ask` from the driver posts a topic.
  - It is kind `question`, from `{ plugin: "zarg", agent: "zarg" }`, and blocking.
  - It is **durable**: a restart does not make it moot.
  - Its answers are the options (the recommended one marked); "Something else…" is the text answer; `about` lists the cards.
- **Asking still works as today:** the driver's cell waits, and the run ends with the interrupt, so the bar's picker shows it and the thread reads "waiting". The topic is a second way to answer it.
- **Answering in the bar** (a run's resume) answers the topic too.
- **Answering in the inbox** resumes the driver exactly as the bar would: the same path, with a new run.
- **Answering after a restart** (no cell waits any more) reaches zarg as a message: `(you answered "<question>": <answer>)`. zarg's next item handles it before the agenda, so the answer is never lost.
- **Replying to the topic** (`POST /inbox/:id/reply {text}`) is "Chat about this":
  - the driver discusses the question, as a message sent while it waits does today;
  - the message is added to the topic;
  - after a restart, the reply reaches zarg as a message about that question.
- **Settling it:**
  - `Inquire.choose` answers the topic as zarg: "zarg chose X: why".
  - A new question from the driver makes the questions it was discussing moot ("zarg asked again").
  - Stopping zarg (Ctrl-C) makes its open questions moot ("stopped").
  - zarg's own what-next question, set aside by new work, becomes moot ("new work arrived").
- **One at a time:** zarg still asks one question at a time. The inbox shows every open one, and each answer resumes the right one.

## Guards (each tested)

1. **A restart while a question is open:** the topic stays open, and a later answer still reaches zarg.
2. **Answered in the bar and in the inbox:** it counts once; the second gets "that topic is answered".
3. **zarg not running when you answer** (stopped, restarting): the answer waits in the topic and is delivered as a message.
4. **A question no longer relevant:** moot with a reason, never silently gone.
5. **Old logs** with `pendingInquiry` interrupts and `zarg.prompt` grants still replay.

## Out of scope

- 2c: every message a thread; zarg's replies inside topics.
- Spec 3's waiting kinds.
