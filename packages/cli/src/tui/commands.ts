import { Schema } from "effect"

/**
 * Slash commands: the one source of truth for the input's `/` surface (ported from zarg v1). The table is
 * decoded through a Schema at load, so a malformed entry is a startup error. The suggestions box, Tab
 * completion, the ghost hint and the lint all read the same table.
 */

/** What may follow the command name: nothing, one of fixed values, free text (rest of line), or a path. */
export const SlashArgKind = Schema.Literals(["none", "choice", "text", "path"])

/** Named `key=value` params and bare flags accepted after the positional argument. */
export const SlashParamSpec = Schema.Struct({
  keys: Schema.Array(Schema.String),
  flags: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const SlashArgSpec = Schema.Struct({
  kind: SlashArgKind,
  /** Ghost-hint word, shown as `<word>`. */
  hint: Schema.optionalKey(Schema.String),
  /** kind "choice": the completable values. */
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The command needs its argument (Enter on the bare name completes instead of running). */
  required: Schema.optionalKey(Schema.Boolean),
  params: Schema.optionalKey(SlashParamSpec),
})

export const SlashCommandSpec = Schema.Struct({
  cmd: Schema.String.check(Schema.isPattern(/^\/[a-z][a-z0-9-]*$/)),
  desc: Schema.String,
  arg: SlashArgSpec,
})

export type SlashCommand = typeof SlashCommandSpec.Type

const decodeCommand = Schema.decodeUnknownSync(SlashCommandSpec)

/** Decode a command table; a bad entry throws naming the entry. */
export const decodeCommands = (raw: ReadonlyArray<unknown>): ReadonlyArray<SlashCommand> =>
  raw.map((c) => {
    try {
      return decodeCommand(c)
    } catch (e) {
      throw new Error(`invalid slash-command entry ${JSON.stringify((c as { cmd?: unknown }).cmd)}: ${(e as Error).message}`)
    }
  })

// @card UX-0058
export const SLASH_COMMANDS = decodeCommands([
  { cmd: "/reconcile", desc: "turn plan and implement on for this session", arg: { kind: "none" } },
  {
    cmd: "/yolo",
    desc: "plugins use every scope they declare without asking (nothing saved)",
    arg: { kind: "choice", choices: ["on", "off"], hint: "on|off", params: { keys: ["plugin"] } },
  },
])

/** What the input currently is, parsed against the table. */
export type SlashInputState =
  | { readonly mode: "command"; readonly matches: ReadonlyArray<SlashCommand>; readonly token: string }
  | { readonly mode: "arg"; readonly command: SlashCommand; readonly token: string; readonly candidates: ReadonlyArray<string>; readonly hint: string }
  | {
      readonly mode: "param"
      readonly command: SlashCommand
      readonly token: string
      readonly candidates: ReadonlyArray<string>
      readonly hint: string
      /** Text before the token: completion writes `prefix + candidate`. */
      readonly prefix: string
    }

// A command name only ("/rec"), or a name plus one argument token ("/bench h", trailing spaces allowed).
const COMMAND_RE = /^\/([a-z][a-z0-9-]*)?$/
const ARG_RE = /^\/([a-z][a-z0-9-]*)(?: +([^\s]*))? *$/

export const argHint = (command: SlashCommand) => `<${command.arg.hint ?? (command.arg.kind === "path" ? "path" : "argument")}>`

const choices = (command: SlashCommand) => (command.arg.kind === "choice" ? (command.arg.choices ?? []) : [])

/** The slash state of `text`, or null when it is not completable slash input (no box, Tab does nothing). */
export const parseSlashInput = (text: string, table: ReadonlyArray<SlashCommand> = SLASH_COMMANDS): SlashInputState | null => {
  if (!text.startsWith("/")) return null
  const name = COMMAND_RE.exec(text)
  if (name) {
    const token = name[1] ?? ""
    const matches = table.filter((c) => c.cmd.slice(1).startsWith(token))
    return matches.length > 0 ? { mode: "command", matches, token } : null
  }
  const param = parseParamInput(text, table)
  if (param) return param
  const arg = ARG_RE.exec(text)
  if (arg) {
    const command = table.find((c) => c.cmd === `/${arg[1] ?? ""}`)
    if (command && command.arg.kind !== "none") {
      const token = arg[2] ?? ""
      return { mode: "arg", command, token, candidates: choices(command).filter((c) => c.startsWith(token)), hint: argHint(command) }
    }
  }
  return null
}

const parseParamInput = (text: string, table: ReadonlyArray<SlashCommand>): SlashInputState | null => {
  const head = /^\/([a-z][a-z0-9-]*) /.exec(text)
  if (!head) return null
  const command = table.find((c) => c.cmd === `/${head[1]}`)
  const params = command?.arg.params
  if (!command || !params) return null
  const endsWithSpace = / $/.test(text)
  const tokens = text.slice(command.cmd.length).trim().split(/\s+/).filter(Boolean)
  // Param territory starts after the positional argument.
  if (tokens.length < (endsWithSpace ? 1 : 2)) return null
  const token = endsWithSpace ? "" : tokens.at(-1)!
  const used = new Set(tokens.slice(1, endsWithSpace ? undefined : -1).map((t) => (t.includes("=") ? t.slice(0, t.indexOf("=")) : t)))
  const remaining = [...params.keys.filter((k) => !used.has(k)).map((k) => `${k}=`), ...(params.flags ?? []).filter((f) => !used.has(f))]
  return {
    mode: "param",
    command,
    token,
    candidates: remaining.filter((c) => c.startsWith(token)),
    hint: remaining.map((c) => `[${c.endsWith("=") ? `${c}…` : c}]`).join(" "),
    prefix: text.slice(0, text.length - token.length),
  }
}

/** Tab bookkeeping: a cycle continues only from the exact text its own Tab wrote. */
export interface SlashCycle {
  readonly mode: SlashInputState["mode"]
  readonly text: string
  readonly candidates: ReadonlyArray<string>
  readonly index: number
}

/**
 * One Tab: the text to write and the next cycle, or null when there is nothing to complete. Repeated Tabs
 * walk the candidates (readline menu-complete); a unique completion of a command that takes an argument
 * gets a trailing space so the cursor lands in the argument slot.
 */
export const stepCompletion = (
  text: string,
  state: SlashInputState,
  prev: SlashCycle | null,
  table: ReadonlyArray<SlashCommand> = SLASH_COMMANDS,
): { readonly text: string; readonly cycle: SlashCycle } | null => {
  const base = state.mode === "command" ? state.matches.map((c) => c.cmd) : state.candidates
  if (base.length === 0) return null
  const continues = prev !== null && prev.mode === state.mode && prev.text === text && (state.mode === "arg" || !text.endsWith(" "))
  const candidates = continues ? prev.candidates : base
  const index = continues ? (prev.index + 1) % candidates.length : 0
  const chosen = candidates[index]
  if (chosen === undefined) return null
  const next =
    state.mode === "command"
      ? chosen + (table.find((c) => c.cmd === chosen)?.arg.kind !== "none" && base.length === 1 && !continues ? " " : "")
      : state.mode === "param"
        ? state.prefix + chosen
        : `${state.command.cmd} ${chosen}`
  return { text: next, cycle: { mode: state.mode, text: next, candidates, index } }
}

export interface SlashLint {
  readonly message: string
}

/**
 * CLI-style validation of a slash command: unknown names, arguments a command does not take, invalid
 * choices, unknown params. Anything still being typed is clean, and so is text that is not command-shaped
 * (a path like "/api/v2 …" is a message).
 */
export const lintSlashInput = (text: string, table: ReadonlyArray<SlashCommand> = SLASH_COMMANDS): SlashLint | null => {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return null
  const name = `/${m[1]}`
  const rest = m[2]
  const exact = table.find((c) => c.cmd === name)
  if (!exact) {
    if (rest === undefined && table.some((c) => c.cmd.startsWith(name))) return null
    return { message: `unknown command ${name}` }
  }
  if (rest === undefined || rest === "") return null
  const spec = exact.arg
  if (spec.kind === "none") return { message: `${name} takes no arguments` }
  if (spec.kind === "text") return null
  const tokens = rest.trim().split(/\s+/)
  const hint = spec.hint ?? spec.kind
  if (tokens.length > 1) {
    const params = spec.params
    if (!params) return { message: `unexpected '${tokens[1]}' — ${name} takes one <${hint}>` }
    const flags = params.flags ?? []
    const accepted = [...params.keys.map((k) => `${k}=`), ...flags].join(", ")
    for (const t of tokens.slice(1)) {
      const eq = t.indexOf("=")
      const bad = eq > 0 ? !params.keys.includes(t.slice(0, eq)) : !flags.includes(t) && !params.keys.some((k) => k.startsWith(t)) && !flags.some((f) => f.startsWith(t))
      if (bad) return { message: `unknown parameter '${t}' — ${name} accepts: ${accepted}` }
    }
  }
  const all = choices(exact)
  const token = tokens[0]!
  if (spec.kind === "choice" && all.length > 0 && !all.some((c) => c.startsWith(token))) {
    return { message: `'${token}' is not a valid <${hint}> (expected one of: ${all.join(", ")})` }
  }
  return null
}
