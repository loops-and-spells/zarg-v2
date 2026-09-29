import { PLUGIN_TONES } from "@zarg/tokens"
import { Schema } from "effect"

/** What a line or cell means; each platform picks its own colour for it. */
/** A plugin names a tone: an intent, identity or severity key (or dim), or an old tone name (`@zarg/tokens`). */
export const Tone = Schema.Literals(PLUGIN_TONES)
/** What a section is for; each platform places roles its own way. */
export const Role = Schema.Literals(["summary", "primary", "log", "pinned", "aside"])
/** An action on a table: on the selected rows (or the highlighted one), on the highlighted row, or on none. */
/** `key` is the terminal's key (shorthand for `keys.terminal`); `keys` maps each platform that has keys to one. */
export const Action = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  key: Schema.optionalKey(Schema.String),
  keys: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  on: Schema.Literals(["selection", "row", "none"]),
  /** Surfaces the action opens (for the acting agent, or another of the plugin's agents), without calling the plugin. */
  opens: Schema.optionalKey(Schema.Array(Schema.Struct({ surface: Schema.String, agent: Schema.optionalKey(Schema.String) }))),
  /** The row's default: Enter on a highlighted row runs it (a table's first default wins). */
  default: Schema.optionalKey(Schema.Boolean),
  /** Runs whenever the table's cursor lands on another row (a list whose choice fills the rest of the view). */
  highlight: Schema.optionalKey(Schema.Boolean),
  /** Asks for a line of text first (this is its placeholder): the act carries it; a row's `text` fills it in. */
  input: Schema.optionalKey(Schema.String),
  /** Drops down a choice first (a Move to a lane): the act carries the chosen id as its text. */
  choices: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))),
})
/** A table column; `order` ranks its values for sorting (a severity's "high", "medium", "low"), else they sort as text with numbers as numbers. */
/** What a column's menu offers beside sorting: ticking by value, nothing, ticking a numeric range (the cell's last number), or a search that sorts by match. */
export const ColumnFilter = Schema.Union([Schema.Literals(["values", "none", "search"]), Schema.Struct({ range: Schema.Tuple([Schema.Number, Schema.Number]), step: Schema.optionalKey(Schema.Number) })])
/** `tone` colours a column's cells; `tones` by value (a severity's "high" in error); a row's own tone wins over both. */
export const Column = Schema.Struct({ id: Schema.String, label: Schema.String, order: Schema.optionalKey(Schema.Array(Schema.String)), filter: Schema.optionalKey(ColumnFilter), tone: Schema.optionalKey(Tone), tones: Schema.optionalKey(Schema.Record(Schema.String, Tone)), ref: Schema.optionalKey(Schema.Literal(true)) })

export const StatsData = Schema.Struct({
  items: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String, tone: Schema.optionalKey(Tone) })),
  progress: Schema.optionalKey(Schema.Struct({ done: Schema.Number, total: Schema.Number })),
})
export const ListData = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, text: Schema.String, detail: Schema.optionalKey(Schema.String), state: Schema.optionalKey(Schema.Literals(["busy", "waiting", "done", "flagged"])), tone: Schema.optionalKey(Tone) }),
  ),
})
export const LogLine = Schema.Struct({ text: Schema.String, tone: Schema.optionalKey(Tone), at: Schema.optionalKey(Schema.Number) })
export const LogData = Schema.Struct({ lines: Schema.Array(LogLine) })
/** `search`: text a searchable table also matches a row by, beyond its cells (a note it does not show). */
export const TableData = Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String, cells: Schema.Record(Schema.String, Schema.String), tone: Schema.optionalKey(Tone), search: Schema.optionalKey(Schema.String), on: Schema.optionalKey(Schema.Boolean), text: Schema.optionalKey(Schema.String), busy: Schema.optionalKey(Schema.Boolean), readonly: Schema.optionalKey(Schema.Boolean) })), actions: Schema.optionalKey(Schema.Array(Schema.String)), labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ text: Schema.String, tone: Tone, glyph: Schema.String }))) })
export const KeyValueData = Schema.Struct({ pairs: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })) })
/** `rows`: for a text that follows a table, the text for each of its rows (by id); `markdown` when none fits. */
/** `actions`: which of the view's own actions show now (a drawer's Resync only when a card changed). `loading`: a line the platform shows in its place, with a spinner, while the plugin works it out. */
export const TextData = Schema.Struct({ markdown: Schema.String, rows: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)), actions: Schema.optionalKey(Schema.Array(Schema.String)), loading: Schema.optionalKey(Schema.String) })

/** A question an agent asks in its conversation. `kind: "grant"`: a permission question, answered only with its options. */
export const QuestionData = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, why: Schema.optionalKey(Schema.String), recommended: Schema.optionalKey(Schema.Boolean) })),
  allowOther: Schema.Boolean,
  otherLabel: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literal("grant")),
})
/** An agent's conversation: its messages, then one slot, the question or the message input. */
export const ConversationData = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.Literals(["user", "agent"]), text: Schema.String })),
  question: Schema.optionalKey(QuestionData),
  status: Schema.optionalKey(Schema.Literals(["idle", "working", "waiting"])),
})

/** The data each leaf kind holds. `tabs` has none of its own: its tabs do. */
/** A kanban: lanes of cards; a card's `tone` is its stripe (a severity), `top` and `badge` its first line, `lines` what follows its title. */
export const BoardData = Schema.Struct({
  lanes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      cards: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          tone: Schema.optionalKey(Tone),
          top: Schema.optionalKey(Schema.String),
          badge: Schema.optionalKey(Schema.String),
          lines: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.String, tone: Schema.optionalKey(Tone) }))),
        }),
      ),
    }),
  ),
})
export const DATA = { stats: StatsData, list: ListData, log: LogData, table: TableData, keyvalue: KeyValueData, text: TextData, conversation: ConversationData, board: BoardData } as const
export type LeafKind = keyof typeof DATA
export type SectionKind = LeafKind | "tabs"
export type LogLine = typeof LogLine.Type

const leafFields = {
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  columns: Schema.optionalKey(Schema.Array(Column)),
  selectable: Schema.optionalKey(Schema.Boolean),
  actions: Schema.optionalKey(Schema.Array(Action)),
  /** A table whose rows join the review queue (every agent's review tables in one list). */
  review: Schema.optionalKey(Schema.Boolean),
  /** A text that follows a table (its section id): it shows the text for that table's highlighted row. */
  follows: Schema.optionalKey(Schema.String),
  /** A section drawn to the right of another (its section id), sharing its height: a detail beside its list. */
  beside: Schema.optionalKey(Schema.String),
  /** A table with a search field: a query keeps the rows it matches, best first. */
  search: Schema.optionalKey(Schema.Boolean),
  /** A table whose rows are on or off (the row's `on`), kept by the plugin: space asks it to flip one (`act "toggle"`). */
  toggle: Schema.optionalKey(Schema.Boolean),
}
export const LayoutLeaf = Schema.Struct({ ...leafFields, kind: Schema.Literals(["stats", "list", "log", "table", "keyvalue", "text", "conversation", "board"]) })
export const LayoutSection = Schema.Union([
  Schema.Struct({ ...leafFields, kind: Schema.Literals(["stats", "list", "log", "table", "keyvalue", "text", "conversation", "board"]), role: Role }),
  Schema.Struct({ id: Schema.String, title: Schema.optionalKey(Schema.String), kind: Schema.Literal("tabs"), role: Role, tabs: Schema.Array(LayoutLeaf) }),
])
/** A view as the manifest and the wire carry it. */
/** How an agent looks in the grid: a stats headline (its gauge), recent lines, one action; sections of the view. */
export const CardSpec = Schema.Struct({ headline: Schema.String, recent: Schema.optionalKey(Schema.String), action: Schema.optionalKey(Schema.String) })
export type CardSpec = typeof CardSpec.Type

/** `actions`: the view's own actions, on no table (a rerun). `card`: the agent's card, when its plugin declares one for this view. */
export const LayoutSchema = Schema.Struct({ name: Schema.String, sections: Schema.Array(LayoutSection), actions: Schema.optionalKey(Schema.Array(Action)), card: Schema.optionalKey(CardSpec) })
export type Layout = typeof LayoutSchema.Type
export type LayoutSection = typeof LayoutSection.Type
export type LayoutLeaf = typeof LayoutLeaf.Type

/**
 * Where a view is shown, as a plugin declares it: the tile area, a panel at one of its edges (with the agent open, or
 * whatever is open), a popover in the shared queue, or a sheet over the tile area. The shell has the last word.
 */
export const Surface = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tile"), name: Schema.String, view: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("panel"),
    name: Schema.String,
    view: Schema.String,
    scope: Schema.Literals(["agent", "shell"]),
    edge: Schema.Literals(["top", "bottom", "right"]),
    /** Rows at the top or bottom, columns at the right. */
    size: Schema.Number,
    input: Schema.Literals(["none", "onFocus"]),
    /** At the right: lie over the tile area (a drawer) instead of taking its room. */
    overlay: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("popover"), name: Schema.String, view: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("sheet"), name: Schema.String, view: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("card"), name: Schema.String, view: Schema.String, headline: Schema.String, recent: Schema.optionalKey(Schema.String), action: Schema.optionalKey(Schema.String) }),
  /** A navigation item above the agents: the operator opens the plugin's view from it; the plugin fills it on `act` "open". */
  Schema.Struct({ kind: Schema.Literal("nav"), name: Schema.String, view: Schema.String, label: Schema.NonEmptyString }),
])
export type Surface = typeof Surface.Type
