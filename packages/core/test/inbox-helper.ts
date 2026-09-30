import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeLog } from "../src/log"
import { INBOX, makeInbox } from "../src/inbox"

export const dirs = () => ({ log: mkdtempSync(join(tmpdir(), "zarg-inbox-log-")), dir: mkdtempSync(join(tmpdir(), "zarg-inbox-")) })
export const setup = async (d = dirs(), now = () => 1000, answered: Array<unknown> = []) => {
  const log = await Effect.runPromise(makeLog(d.log, (t) => t))
  const inbox = await Effect.runPromise(makeInbox({ log, dir: d.dir, now, answered: (t, r) => Effect.sync(() => void answered.push([t.id, r])) }))
  const events = () => log.all().filter((e) => e.type === "CUSTOM" && e.name === INBOX).map((e) => (e.value as { topic: { id: string; state: string } }).topic)
  return { inbox, log, events, d, answered }
}
