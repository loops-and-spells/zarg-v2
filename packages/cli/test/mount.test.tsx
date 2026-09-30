import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { initial, type Session, type SessionState } from "@zarg/client"
import { mount, type Opened } from "../src/tui/run"

const opened = (state: SessionState) => {
  let closed = false
  const session: Session = {
    state: () => state,
    subscribe: () => () => {},
    start: () => {},
    answer: () => {},
    send: () => {},
    stop: () => {},
    close: () => {},
    command: () => {},
    pluginCommands: () => [],
    act: () => Promise.resolve(),
    answerAgent: () => Promise.resolve(),
    answerPrompt: () => Promise.resolve(), answerTopic: () => Promise.resolve(), answerTopics: () => Promise.resolve(), snoozeTopic: () => Promise.resolve(), readTopic: () => Promise.resolve(),
    closePrompt: () => Promise.resolve(),
    archive: () => Promise.resolve(),
  }
  const o: Opened = { session, meta: { threadId: "main", mode: "child" }, close: async () => void (closed = true) }
  return { o, closed: () => closed }
}

describe("mount", () => {
  test("a destroyed renderer (a signal such as SIGHUP) closes the session and ends the TUI", async () => {
    const t = await createTestRenderer({ width: 80, height: 24 })
    const f = opened({ thread: initial("main"), core: "up" })
    const done = mount(t.renderer, f.o)
    await t.renderOnce()
    t.renderer.destroy()
    await done
    expect(f.closed()).toBe(true)
  })

  test("Ctrl-D still exits after the app crashed while rendering", async () => {
    const t = await createTestRenderer({ width: 80, height: 24 })
    // A malformed activity node (no criteria) makes the agents tree throw.
    const broken = { id: "rlm-1", parent: null, preset: "driver", depth: 0, turns: 1, budget: 1, status: "running", decisions: [{ kind: "atomize", atomic: true }] }
    const f = opened({ thread: { ...initial("main"), rlms: { "rlm-1": broken as never } }, core: "up" })
    const done = mount(t.renderer, f.o)
    await t.renderOnce()
    t.mockInput.pressKey("d", { ctrl: true })
    await done
    expect(f.closed()).toBe(true)
    expect(t.renderer.isDestroyed).toBe(true)
  })
})
