# Agents everywhere: zarg as a plugin agent, a tiled shell, attention

Date: 2026-09-27
Status: design approved in conversation (four sections, mockups reviewed), pending written review
Parents: `docs/superpowers/specs/2026-09-27-agent-views-design.md` (views, sections, platforms), `docs/superpowers/specs/2026-09-27-service-plugins-rehearse-design.md` (plugin agents, powers)
Replaces: the earlier root-agent spec (commit 5e0fa7d), which kept zarg in the core and had no tiling

## Outcome

Every agent is a plugin agent, zarg included. zarg, the conversational AI, becomes the first-party agent plugin `agent-zarg`: the driver loop, the write gate, what next, the findings gate and zarg's conversation leave the core. The core only hosts: threads and their log, the server, the plugin host and grants, and reconcile. It talks to every agent through one contract and never knows how an agent thinks.

The TUI becomes a small tiling shell. zarg's conversation is always on screen, beside the view of the agent you opened and the agents tree. Alt+arrows move between tiles. Agents that need the developer say so with attention (◆), shown in the tree, counted in its title, listed on the status line and reachable with `g`.

## 1. Agents and runtimes

- **One archetype, two runtimes.** A plugin declares `archetype: "agent"` and `runtime: "trusted" | "sandboxed"` (default `sandboxed`). The host refuses `trusted` for a plugin that is not first-party (its bundle hash pinned in `first-party-hashes.ts`).
- **Trusted:** the agent's bundle is built for Bun (`target: "bun"`), its hash checked, and imported into the core process. It has full Bun, so it can run the RLM kernel (Bun Workers, the TypeScript checker) and model tool calls. It receives an `AgentHost` interface (below) instead of powers.
- **Sandboxed:** today's SES process and powers, plus the agent powers (views, attention, conversation). Third-party agents can only be sandboxed. A trusted agent in its own process (for third parties) is later work behind the same contract.
- **The contract.** The core calls an agent only through:
  - `start({ thread })`: begin work on a thread (zarg: its driver loop on `main`);
  - `stop({ thread })`;
  - `message({ thread, agent, text })`: the developer said something to one of its agents;
  - `answer({ thread, agent, question, answer })`: the developer answered one of its questions;
  - `act({ thread, agent, action, section, rows })`: an action on its view (as today).
  The agent tells the core, through its runtime: agent rows (start, status, end), view pushes, attention, and, for trusted agents, conversation events on its thread (below).
- **First-party trust ≠ trusted runtime.** Rehearse is first-party but sandboxed: it never runs a kernel. Only agents that need Bun run trusted.

### The trusted host interface (`AgentHost`)

What `agent-zarg` needs from the core, as one Effect service the core provides:

| member | what it is |
|---|---|
| `model` | the `Model` service (streaming, tool calls, reasoning) and the configured roles |
| `decisions` | the decision model |
| `plugins` | the plugin host: `tools`, `manifests`, `call` (the write pipeline), `invoke`, `agenda`, `suggest`, `render`, `affected`, `exclusive` |
| `graph` | the graph store (`snapshot`) |
| `log` | the thread log: `append` (AG-UI events on a thread), `transcript`, `redact`, `history` |
| `threads` | the thread's run lifecycle: its inbox of messages and answers, `runStarted` / `runFinished` / `runInterrupted` on the wire |
| `outside` | outside-repository reads (grants, grant questions) |
| `agents` | agent rows, views and attention (the same the sandboxed powers reach) |
| `settings` | the project config (`rlm`, `reconcile`, roles) and the project root |

`agent-zarg` builds the RLM (`@zarg/rlm`), its service factory (Graph, Gherkin and other plugin services, Inquire over its own conversation, Fs:read, Decisions, Findings, Rehearse, Rlm) and its observe callback (activity, transcript, the RLM's view) from these.

## 2. Packages

- **`packages/agent-zarg` (`@zarg/agent-zarg`), new, trusted:** moves from `core`: the driver loop (`thread.ts`), the write gate (`driver.ts`), what next and gaps (`gaps.ts`, `intent.ts`), the findings gate (`findings.ts`), the RLM view (`rlm-view.ts`) and the RLM activity (`activity.ts`) with `closeStale`'s knowledge of RLM rows. zarg's conversation is its agent `zarg`.
- **`packages/core`, stays:** threads and the log, the HTTP and AG-UI server, the plugin host wiring and grants, `YOLO`, the ViewStore, plugin agents, actions, reconcile. It loads agents like other plugins and starts `zarg` on `main`.
- **`@zarg/rlm`, `@zarg/kernel`:** libraries, used by `agent-zarg` and by reconcile (plan and implement stay in the core for now).
- **`packages/plugin-rehearse` → `packages/agent-rehearse` (`@zarg/agent-rehearse`), sandboxed.** Its plugin name stays `rehearse`, so grants, `yolo.json`, `/rehearse` and `.zarg/rehearse/` records carry over. The first-party build list, the calibration task, `AGENTS.md` and the import rule follow the new folder.
- **Naming rule:** `agent-*` agents, `provider-*` providers, `plugin-*` graph and service plugins.

## 3. Conversation and attention

### The `conversation` section kind (`@zarg/view`)

| field | type |
|---|---|
| `messages` | `[{ id, role: "user" \| "agent", text }]` |
| `question?` | `{ id, question, options: [{ id, label, why?, recommended? }], allowOther, otherLabel?, kind?: "grant" }` |
| `status?` | `idle` \| `working` \| `waiting` |

- One slot below the messages: the question, or the message input (when nothing is asked, or while chatting about the question). Never both.
- Behaviour in `@zarg/view` (`conversationUi`: the picked row, the free-text row, chatting, answered): `rows`, `pick`, `answer`, `chat`, `back`. A grant question offers only its options. The TUI's picker logic moves here from `view-tui`.
- **zarg's conversation keeps AG-UI:** messages and interrupts on its thread, the wire any AG-UI client reads. The client builds zarg's conversation section from thread state (messages, the pending interrupt, run status); answers and messages go through `/runs` as today.
- **A sandboxed agent's conversation:** it declares a `conversation` section and uses the SDK `Conversation` service: `say(agent, text)`, `ask(agent, question)` (completes with the answer), and its `message` method receives what the developer sends. These travel as view pushes and as the contract's `message` / `answer` calls.

### Attention

- SDK `Attention.request(agent, reason)` / `clear(agent)` (sandboxed: the `agents.event` power; trusted: `AgentHost.agents`). The core keeps `attention: { reason, since }` on the agent's row; a restarted core's clean-up clears stale attention.
- zarg requests attention while its question waits (`asks: <question>`, shortened) and clears it when answered.
- Rehearse testers request attention when a run is done with findings to review (`N findings to review`) and clear it when none remain.

## 4. The tiled shell (`@zarg/view-tui`)

- **Tiles:** zarg's conversation (always), the open agent's view (when one is open), the agents tree. Wide: side by side (zarg about 38%, the view the rest, the tree 30 columns). Narrow (under 100 columns): zarg above the open view, the tree folded to a one-line strip of rows with their ◆.
- **Keys:** Alt+arrows move focus between tiles; Tab moves between sections inside the focused tile; the question or the message input take keys only while zarg's tile has focus. Enter on a tree row opens that agent in the view tile; Escape in the view tile closes it. The mouse focuses the tile it clicks (and a table row, as today).
- **Attention:** ◆ before an agent's name with its reason in place of its progress, in the attention colour; the tree's title `Agents ◆N`; the status line lists the first two reasons; `g` opens the next agent that needs the developer (tree order, zarg first).
- **Removed:** the shell's own message box and picker (they are the conversation renderer now) and the call-to-action line (zarg is always visible).

## Errors

- A trusted bundle whose hash is not first-party: refused at load, with an agenda item for the developer.
- `agent-zarg` missing or failing to load: the core serves, the conversation tile says "zarg is not loaded: <reason>", and the agenda item explains.
- An agent's `start` failing: its row is `failed` with the error; the core stays up.
- A sandboxed agent's conversation push that does not fit its section: refused to the plugin, as other pushes.

## Testing

- `@zarg/view`: the `conversation` kind and behaviour (pick, answer by option or text, chat and back, grant questions offer options only); portability still holds.
- Plugin host: `archetype: "agent"`; `runtime: "trusted"` refused for a non-first-party bundle; a trusted agent imported in-process gets `AgentHost`; the contract calls reach sandboxed and trusted agents alike.
- `agent-zarg`: the driver loop's existing tests move with it and pass against a fake `AgentHost`; a stub-model run on `main` through the loaded plugin reaches the scripted question (the core's process test).
- Core: `zarg` starts on `main` at load; stop and restart; attention on rows and its clean-up; `/runs` answers reach zarg.
- Rehearse (renamed): its tests pass from `agent-rehearse`; testers request and clear attention.
- TUI (`testRender` frames at 130×22 and 80×24): the three tiles; the narrow stack with the strip; Alt+arrows move focus; the conversation slot shows the question or the input; ◆, the count, the status line and `g`.

## Scope

In: the agent archetype and both runtimes; the contract and `AgentHost`; `agent-zarg` (moving the driver out of the core); renaming rehearse to `agent-rehearse` as a sandboxed agent; the `conversation` section kind and behaviour, `Conversation` and `Attention` services; the tiled shell with Alt+arrows and attention.

Out: trusted agents in their own process (third-party RLM agents); moving reconcile's plan and implement into agents; web and native renderers; notifications outside zarg.
