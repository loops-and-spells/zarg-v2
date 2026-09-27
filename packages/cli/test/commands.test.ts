import { describe, expect, test } from "bun:test"
import { decodeCommands, lintSlashInput, parseSlashInput, SLASH_COMMANDS, type SlashCycle, stepCompletion } from "../src/tui/commands"

// A fixture table with every argument kind (the real table has only /reconcile so far).
const T = decodeCommands([
  { cmd: "/reconcile", desc: "turn plan and implement on for this session", arg: { kind: "none" } },
  { cmd: "/bench", desc: "run a suite", arg: { kind: "choice", hint: "suite", choices: ["humaneval", "mbpp"], required: true, params: { keys: ["limit", "mode"], flags: ["fast"] } } },
  { cmd: "/btw", desc: "steer the running work", arg: { kind: "text", hint: "aside", required: true } },
  { cmd: "/open", desc: "open a file", arg: { kind: "path" } },
])

describe("the command table", () => {
  test("is decoded at load; a malformed entry fails loudly", () => {
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toEqual(["/reconcile", "/yolo"])
    expect(() => decodeCommands([{ cmd: "reconcile", desc: "x", arg: { kind: "none" } }])).toThrow(/invalid slash-command entry "reconcile"/)
    expect(() => decodeCommands([{ cmd: "/x", desc: "x", arg: { kind: "maybe" } }])).toThrow()
  })
})

describe("parseSlashInput", () => {
  test("bare / lists every command; a prefix narrows; unknown prefixes and non-slash text are not slash input", () => {
    expect(parseSlashInput("/", T)).toMatchObject({ mode: "command", token: "" })
    expect((parseSlashInput("/", T) as { matches: ReadonlyArray<{ cmd: string }> }).matches.map((c) => c.cmd)).toEqual(["/reconcile", "/bench", "/btw", "/open"])
    expect((parseSlashInput("/b", T) as { matches: ReadonlyArray<{ cmd: string }> }).matches.map((c) => c.cmd)).toEqual(["/bench", "/btw"])
    expect(parseSlashInput("/zzz", T)).toBeNull()
    expect(parseSlashInput("hello", T)).toBeNull()
    expect(parseSlashInput("/api/v2 is slow", T)).toBeNull()
  })

  test("a no-arg command plus a token is not slash input; an argument command enters arg mode with its hint", () => {
    expect(parseSlashInput("/reconcile now", T)).toBeNull()
    expect(parseSlashInput("/btw ", T)).toMatchObject({ mode: "arg", token: "", candidates: [], hint: "<aside>" })
    expect(parseSlashInput("/bench h", T)).toMatchObject({ mode: "arg", token: "h", candidates: ["humaneval"], hint: "<suite>" })
    expect(parseSlashInput("/open ", T)).toMatchObject({ mode: "arg", hint: "<path>" })
  })

  test("past the positional argument, declared params complete; used ones drop out", () => {
    expect(parseSlashInput("/bench humaneval ", T)).toMatchObject({ mode: "param", candidates: ["limit=", "mode=", "fast"], prefix: "/bench humaneval " })
    expect(parseSlashInput("/bench humaneval limit=3 m", T)).toMatchObject({ mode: "param", token: "m", candidates: ["mode="] })
  })
})

describe("stepCompletion (Tab)", () => {
  test("Tab on / cycles every command without a trailing space", () => {
    let text = "/"
    let cycle: SlashCycle | null = null
    const seen: Array<string> = []
    for (let i = 0; i < 5; i++) {
      const step: { text: string; cycle: SlashCycle } = stepCompletion(text, parseSlashInput(text, T)!, cycle, T)!
      text = step.text
      cycle = step.cycle
      seen.push(text)
    }
    expect(seen).toEqual(["/reconcile", "/bench", "/btw", "/open", "/reconcile"])
  })

  test("a unique completion with an argument lands in the argument slot; without one it stays bare", () => {
    expect(stepCompletion("/bt", parseSlashInput("/bt", T)!, null, T)!.text).toBe("/btw ")
    expect(stepCompletion("/rec", parseSlashInput("/rec", T)!, null, T)!.text).toBe("/reconcile")
  })

  test("choice values cycle; params complete in place; no candidates is a no-op; any edit breaks the cycle", () => {
    const first = stepCompletion("/bench ", parseSlashInput("/bench ", T)!, null, T)!
    expect(first.text).toBe("/bench humaneval")
    expect(stepCompletion(first.text, parseSlashInput(first.text, T)!, first.cycle, T)!.text).toBe("/bench mbpp")
    expect(stepCompletion("/bench mbpp l", parseSlashInput("/bench mbpp l", T)!, null, T)!.text).toBe("/bench mbpp limit=")
    expect(stepCompletion("/btw ", parseSlashInput("/btw ", T)!, null, T)).toBeNull()
    expect(stepCompletion("/b", parseSlashInput("/b", T)!, { ...first.cycle, text: "/bx" }, T)!.text).toBe("/bench")
  })
})

describe("lintSlashInput", () => {
  test("in-progress prefixes, text arguments and non-commands are clean", () => {
    expect(lintSlashInput("/rec", T)).toBeNull()
    expect(lintSlashInput("/btw anything at all goes", T)).toBeNull()
    expect(lintSlashInput("/api/v2 is slow", T)).toBeNull()
    expect(lintSlashInput("hello", T)).toBeNull()
    expect(lintSlashInput("/bench humaneval lim", T)).toBeNull()
  })

  test("unknown commands, stray arguments, bad choices and unknown params are flagged", () => {
    expect(lintSlashInput("/nope", T)).toEqual({ message: "unknown command /nope" })
    expect(lintSlashInput("/reconcile now", T)).toEqual({ message: "/reconcile takes no arguments" })
    expect(lintSlashInput("/bench xyz", T)).toEqual({ message: "'xyz' is not a valid <suite> (expected one of: humaneval, mbpp)" })
    expect(lintSlashInput("/bench humaneval speed=1", T)?.message).toContain("unknown parameter 'speed=1'")
    expect(lintSlashInput("/open a b", T)?.message).toContain("unexpected 'b'")
  })
})
