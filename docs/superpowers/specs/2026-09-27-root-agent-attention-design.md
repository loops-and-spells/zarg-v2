# zarg as the root agent; agents ask for attention

Date: 2026-09-27
Status: direction approved in conversation (mockups reviewed), pending written review
Parents: `docs/superpowers/specs/2026-09-27-agent-views-design.md` (agent views, sections, platforms)
Next: the RLM as an agent plugin (its own process, kernel and model powers), its own spec

## Outcome

The conversational AI, zarg, is the root agent of each thread. Its view is the conversation: its messages, then one slot at the bottom that is either its question or the message input, never both. The shell has no conversation of its own: no global message box, no global question picker. Every other agent shows its own view; an agent that wants a conversation declares one with the same section kind, from the SDK.

Agents ask for the developer's attention instead of interrupting. An agent that needs the developer (zarg with a question, a tester with findings to review) is marked ◆ with a short reason in the agents tree, counted in the pane's title, listed on the status line, and reachable with one key. While another agent's view is open, zarg's pending question shows as a one-line call to action at the top of that view, not as a question box.

## Decisions

- **zarg is an agent.** The agents tree has a `zarg` row at the top of each thread; the driver's RLMs (one tree per driver item) are its children. Opening `zarg` shows the conversation. zarg is the view the TUI opens on.
- **One conversation slot.** A conversation section's bottom slot shows its pending question, or, when nothing is asked (or the developer picked "Chat about this"), the message input.
- **Conversation is a section kind** in `@zarg/view`, platform-free like the others, with its behaviour (pick an option, type the free-text answer, chat about the question, send a message) in `@zarg/view` so every platform renders it the same way.
- **Attention is agent state,** not a popup: `attention: { reason, since }` on the agent's row, set and cleared by the agent (zarg: automatically while its question waits).
- **Grant questions are zarg's questions** (kind `grant`): zarg asks them in its conversation, and its row reads "asks: Allow vm-grid to load?". There is no separate row per waiting plugin.
- **This spec keeps the RLM in the core.** zarg's conversation is built from what the core already sends (messages, interrupts); plugin agents' conversations come through the Views they push. Moving the RLM into its own plugin process is the next spec.

## The conversation section (`@zarg/view`)

A new kind, `conversation`:

| field | type |
|---|---|
| `messages` | `[{ id, role: "user" \| "agent", text }]` |
| `question?` | `{ id, question, options: [{ id, label, why?, recommended? }], allowOther, otherLabel?, kind?: "grant" }` |
| `status?` | `idle` \| `working` \| `waiting` |

- Role is usually `primary` (zarg's view is one conversation section).
- Behaviour (`@zarg/view`): `conversationUi` holds the picked option, whether the free-text row is being typed, whether the developer is chatting about the question, and the draft. Calls: `pick(delta)`, `answer()` (the picked option or the typed text), `chat()` (the slot becomes the message input for this question; Escape goes back to the options), `send(text)`. A `kind: "grant"` question offers only its options (no free text, no chat), as today.
- Every platform renderer draws `conversation`; the TUI's current picker and message box move into its renderer (`@zarg/view-tui`), so the shell's own picker and message box go.

### zarg's conversation

- The client builds zarg's view from the thread state it already keeps: `messages` from the text messages, `question` from the pending interrupt, `status` from the run status. Nothing new travels on the wire for it.
- Answers and messages go the way they go today (`session.answer`, `session.send`); the conversation renderer calls them through the behaviour.

### A plugin agent's conversation

- The plugin declares a `conversation` section in its view and uses a new SDK service, `Conversation`:
  - `say(agent, text)`: appends a message;
  - `ask(agent, question)`: sets the question and waits for the answer (an Effect that completes with `{ choice }` or `{ other }`);
  - messages the developer sends reach the plugin's `message({ agent, text })` method.
- Answers and messages travel as actions on the agent (`answer`, `message`), which the core routes to the plugin like any action. Pushes are checked like other view pushes.

## Attention

- **SDK:** `Attention.request(agent, reason)` and `Attention.clear(agent)`, over the `agents.event` power (scope `agents`). The core keeps `attention` on the agent's row in the activity stream (`/rlms/<id>` gains `attention?: { reason, since }`), so every client sees it and a restarted core's clean-up (agents a previous core left running are stopped) also clears stale attention.
- **zarg:** attention is set while a question waits (reason: `asks: <question>`, shortened) and cleared when it is answered.
- **Rehearse:** a tester requests attention when its run is done and it has findings to review (`N findings to review`) and clears it when none are left open.
- **TUI:**
  - a ◆ before the agent's name and its reason in place of its progress text, in the attention colour;
  - the pane's title counts them: `Agents  ◆ 3 need you`;
  - the status line lists the first two reasons, and `g` opens the next agent that needs the developer (in tree order, zarg first);
  - in any view other than zarg's, zarg's pending question is a one-line call to action at the top: `◆ zarg asks: <question>   Enter answer · Esc later`. Enter opens zarg's view on the question; Esc hides the line until zarg asks something new. The open view keeps its keys otherwise.

## The shell after this

- Left: the open agent's view (zarg's conversation by default). Right: the agents tree. Bottom: the status line.
- Escape in another agent's view goes back to zarg's view. Tab moves between the view's sections and the agents pane as today.
- The slash-command box is part of zarg's message input (slash commands are things said to zarg).

## Testing

- `@zarg/view`: `conversation` data round trips; behaviour (pick, answer with an option, answer with typed text, chat then Escape back to the options, send); a grant question offers only its options; the portability test still passes.
- Client: zarg's view is built from thread state: messages, the pending question, status; answering clears the question and shows the input.
- TUI (`testRender` frames at the mockup's sizes):
  - zarg's view with a question: the question in the slot, no message input;
  - without a question: the message input in the slot;
  - another agent's view with zarg asking: the call-to-action line, Enter opens zarg's view on the question, Esc hides it;
  - ◆ rows, the pane's count, the status line, and `g` jumping to the next.
- SDK and core: `Attention.request` / `clear` reach the row; a plugin conversation's `ask` completes when the developer answers (action routed to the plugin); a restarted core clears stale attention.
- Rehearse: a tester with findings to review requests attention; applying or dismissing the last clears it.

## Scope

In: the `conversation` section kind and behaviour; zarg as the root agent with its conversation view; the `Conversation` and `Attention` SDK services and their core routing; attention in the TUI (◆ rows, count, status line, `g`, the call-to-action line); removing the shell's global message box and picker; rehearse testers requesting attention.

Out: moving the RLM into its own plugin process; web and native renderers; notifications outside zarg (desktop, sound).
