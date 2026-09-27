# Agent views: agents own their window, on any platform

Date: 2026-09-27
Status: design approved in conversation (four sections), pending written review
Parents: `docs/superpowers/specs/2026-09-27-service-plugins-rehearse-design.md` (plugin agents, bodies, actions), `docs/superpowers/specs/2026-09-26-core-driver-tui-design.md` (the TUI, AG-UI)
Next: project B, the RLM as an agent plugin (its own spec, over this contract)

## Outcome

When the developer opens an agent, the agent owns the main window. It declares a view made of sections (progress, a list of workers, a log, tables in tabs with actions), and every section scrolls on its own. The tester shows its work (workers walking stories, steps checked) with its findings pinned at the bottom; the RLM shows its status, its current cell and its history.

The contract is platform-free. A view says what each section is (its kind and its role), never where it goes or how it looks. The terminal is the first platform renderer; a web renderer (react-dom) and a native one (react-native) come later as new packages over the same contract, each with its own navigation and layout, with no change to plugins, the core or the wire.

Why now: bodies (the previous step) stream history and tables as plain lines in one scrollbox, polled once a second. A tester with eight workers in flight, a long step log and a findings table does not fit that, and the next project (agents as plugins, the RLM first) needs one way for every agent to draw itself.

## Decisions

- **Declared layout, pushed data.** A plugin declares each view's sections in its manifest (typed in the SDK). At runtime it pushes only data: set a section's content, or append lines to a log.
- **AG-UI carries views.** One activity per agent view (`ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA`, `activityType: "zarg.view"`, JSON Patch deltas), next to the `zarg.rlm` activity the agents tree already uses. Any AG-UI client can reduce them.
- **Platform renderers.** `@zarg/view` holds the schema, the reducer and the behaviour (selection, tabs, focus, a `useView` hook); it imports only React and effect. Each platform package draws every section kind and owns its shell (navigation, layout, input).
- **Roles, not positions.** Each section has a role (`summary`, `primary`, `log`, `pinned`, `aside`); each platform places roles its own way.
- **Catalog only.** Plugins use the section kinds `@zarg/view` defines; they never ship UI code. A new kind is added to `@zarg/view`, and every renderer must draw it before it typechecks.
- **Views live in the core.** The core keeps each view's state per thread and agent, checks every push, persists view events in the thread log and replays them on attach. A view outlives the plugin process that drew it.

## The contract (`@zarg/view`)

### Sections

Every section has `id`, `kind`, `role` and an optional `title`.

| kind | data | used for |
|---|---|---|
| `stats` | `items: [{label, value, tone?}]`, `progress?: {done, total}` | the tester's top line; an RLM's turns and tokens |
| `list` | `items: [{id, text, detail?, state?, tone?}]`, `state` one of `busy`, `waiting`, `done`, `flagged` | the tester's workers |
| `log` | `lines: [{text, tone?, at?}]`, append-only | the tester's steps; an RLM's history |
| `table` | `columns: [{id, label}]`, `rows: [{id, cells: {<column>: string}, tone?}]`, `selectable?`, `actions?` | findings, likes |
| `tabs` | `tabs: [{id, title, badge?, section}]`, each `section` a `table`, `list`, `log`, `keyvalue` or `text` | Findings / Likes |
| `keyvalue` | `pairs: [{key, value}]` | a finding's details |
| `text` | `markdown` | a run's report; an RLM's task and current cell |

- **Tone** is semantic: `normal`, `ok`, `warn`, `error`, `dim`, `accent`. Views carry no colours, glyphs, widths or heights.
- **Role** is one of `summary`, `primary`, `log`, `pinned`, `aside`.
- **Actions** belong to tables: `{id, label, key?, on}` with `on` one of `selection` (the selected rows, or the highlighted row when none are selected), `row` (the highlighted row) or `none`. `key` is a hint only platforms with keys show.

### Declaring a view (SDK)

```ts
import { defineView } from "@zarg/plugin-sdk"

export const TesterView = defineView("tester", {
  progress: { kind: "stats", role: "summary" },
  workers: { kind: "list", role: "primary", title: "Workers" },
  steps: { kind: "log", role: "log", title: "Steps" },
  review: {
    kind: "tabs",
    role: "pinned",
    tabs: {
      findings: { kind: "table", title: "Findings", columns: FINDING_COLUMNS, selectable: true, actions: [APPLY, DISMISS] },
      likes: { kind: "table", title: "Likes", columns: LIKE_COLUMNS },
    },
  },
})

definePlugin({ /* … */, views: [TesterView, RunView] })
```

- The manifest carries each view's layout (section ids, kinds, roles, titles, table columns and actions). The build refuses a view with duplicate ids, an unknown kind or an action outside a table.
- An agent chooses its view when it starts: `agents.start({ id, view: "tester", title, task, parent? })`. A view the plugin did not declare is refused. Starting without a view gives the agent the default view: a `log` section fed by `agents.step`.
- `agents.step` keeps working: it appends to the view's first `log` section.

### Pushing data (the `Views` power)

The SDK service `Views` is typed from the declared views:

```ts
const views = yield* Views
yield* views.set(agent, TesterView, "workers", { items })        // checked against the section's kind
yield* views.set(agent, TesterView, "review.findings", { rows })  // a tab inside a tabs section
yield* views.append(agent, TesterView, "steps", [{ text, tone: "warn" }]) // logs only
```

- A wrong section id, or data that does not fit the section's kind, is a type error, and the core checks again at runtime (the plugin is untrusted).
- The power needs the `agents` scope (no new grant). It reaches only the calling plugin's own agents.

## Data flow

```
plugin ─Views power─▶ host ─▶ core ViewStore ─AG-UI─▶ client reducer ─▶ platform renderer
```

1. **Start.** `agents.start({ id, view })` makes the core create the view from the manifest's layout and emit `ACTIVITY_SNAPSHOT { messageId: "<thread>:<agent>", activityType: "zarg.view", content: { agent, view, layout, data: {} } }`.
2. **Push.** `views.set` / `views.append` reach the core through the host. The core checks the data against the section, updates its state and emits `ACTIVITY_DELTA` with JSON Patch: `replace /data/<section>` for a set, `add /data/<section>/lines/-` per appended line. A push that fails the check fails back to the plugin as a `PluginError`; nothing reaches the client.
3. **Coalescing.** Pushes for one agent within 100 ms go out as one delta, so a tester's workers do not flood the stream.
4. **Persistence.** View events go into the thread log with the rest of the stream; a client that attaches later replays them. A `log` section keeps its last 2000 lines in the view (older lines stay in the transcript). The view survives the plugin process idling or restarting; a restarted plugin sets its sections again.
5. **Client.** `@zarg/view`'s reducer folds the events into `views[agent]`. `@zarg/client` keeps it in thread state, and `useView(agent)` gives a renderer the view and its behaviour.
6. **Actions.** `POST /threads/:id/agents/:agent/actions/:action { section, rows }` calls the plugin's `act({ agent, action, section, rows })` and shows its `{ notice }`. The core still records `apply` for the findings gate.
7. **Removed.** The plugin `body` method, `GET …/body`, `Session.body` and the TUI's once-a-second polling.

Errors: a gone plugin's view stays readable and its actions answer with a notice ("plugin X is not loaded"). A view event for an agent the client does not know is kept until the agent's row arrives.

## Views zarg draws

### Tester (`tester`, one per person under "Affected users")

- `progress` (stats): distinct steps checked of those to check, flagged, unreachable, elapsed.
- `workers` (list): one item per story in flight. The walk sets it as story fibers start, advance, wait for another story at a shared step (`waiting`, with which story and card), and finish (removed). Its title says how many of the `in_flight` slots are busy.
- `steps` (log): one line per step this tester screened: scores, then the flags and the finding count.
- `review` (tabs, pinned): Findings and Likes. While the run goes, they hold this tester's diagnosed findings; once the run is done, the consolidated findings (`R-…`) this person contributed to, selectable, with apply and dismiss.

### Run (`run`, the parent row)

- `progress` over all testers, `report` (text) once done, and `review` over all findings, with the same actions.

### RLM (`rlm`)

- `status` (stats): turns of budget, tokens, preset, state.
- `task` (text): the task, then the current cell's code.
- `history` (log): the history lines the history view shows today.

Until project B, the core pushes the RLM's view itself, through the same ViewStore calls a plugin's pushes use.

## Platforms

```
@zarg/view         schema, reducer, behaviour, useView   (React and effect only)
@zarg/client       app model: threads, agents, views, navigation state   (platform-free)
@zarg/view-tui     terminal shell + section renderers    (this project)
@zarg/view-web     react-dom shell + section renderers   (later)
@zarg/view-native  react-native shell + section renderers (later)
```

- Each renderer package exports `renderers: Record<SectionKind, Component>`: a new kind fails to typecheck in every renderer until it draws it.
- Each platform owns its shell: navigation (the terminal's panes, Tab and Esc; the web's routes such as `/threads/main/agents/rehearse:tester-1`; native's stack and sheets), layout by role, and input (keys, clicks, touches), all calling the same behaviour functions (`select`, `act`, `nextTab`, `focusSection`).
- How roles are placed is the platform's: the terminal stacks them (below); a web layout may put `primary` and `log` side by side with `pinned` as a panel; a phone may show `summary` on top, `primary` and `log` as tabs, and `pinned` as a bottom sheet with a count badge.

### The terminal renderer (`@zarg/view-tui`)

- The shell moves here from `packages/cli/src/tui` (conversation, agents pane, question picker, status line); `packages/cli` keeps its commands and mounts the shell.
- Each section is its own scrollbox. Stacking by role: `summary` on top (its height), `primary` up to a third of the window, `log` fills the rest, `pinned` at the bottom (up to 40% of the window), `aside` below `log`.
- Keys in an agent's view: Tab and Shift-Tab move focus between sections (the focused one is outlined); ↑↓, PgUp and PgDn scroll it or move a table's row cursor; `[` and `]` switch tabs; space selects a row; an action's key acts; Esc goes back to the conversation. The mouse wheel scrolls the section under the pointer.
- The layout matches the mockup reviewed in conversation (progress line; Workers; Steps; Findings / Likes pinned at the bottom; the agents pane on the right).

## Testing

- `@zarg/view`: schema round trips; the reducer (a snapshot then set, append and replace deltas; a delta for an unknown view kept until its snapshot; a log capped at 2000 lines); behaviour (select, tab switch, section focus, an action's rows); a test that fails if `@zarg/view` imports `react-dom`, `@opentui/*`, `react-native` or `node:*`.
- Platform independence: one view rendered to HTML with `react-dom/server` through a throwaway renderer inside the test (no web package ships).
- SDK: `defineView` typing (a wrong section id or data kind is a compile error, pinned with `@ts-expect-error`); manifests carry views; the build refuses a malformed view.
- Core: the ViewStore checks pushes, coalesces within 100 ms, persists view events and replays them on attach; a bad push fails back to the plugin; a gone plugin's view stays readable and its actions become a notice; `apply` is still recorded.
- Terminal: `testRender` frames of the tester view (summary on top, pinned at the bottom), each section scrolling on its own, Tab cycling sections, space then `a` applying the selected rows, and the RLM view showing its history.
- Rehearse: the workers list follows the walk (busy, waiting at a shared step, gone when done), and the review tables fill during the run and after consolidation.

## Scope

In: `@zarg/view`; `@zarg/view-tui` (the shell moved from `packages/cli`, section renderers); `defineView` and the `Views` power; the core ViewStore and its AG-UI events; the tester, run and RLM views; removing `body` and its polling.

Out: the web and native renderers and shells; custom sections a plugin draws itself; project B (the RLM as an agent plugin, and an `agent` plugin archetype), which gets its own spec over this contract.
