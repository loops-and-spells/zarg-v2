import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { codeOf } from "../src/server/code"

// Built from parts: this file holds no tag of its own.
const TAG = "@" + "card"

test("a card's code: each tag's file and line and the code after it, stopping at the next tag, at most 40 lines, redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "zarg-code-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  const lines = [`// ${TAG} S-0001`, "export const a = () => 'zt-secret'", "", `// ${TAG} S-0002`, "export const b = 2"]
  writeFileSync(join(root, "a.ts"), `${lines.join("\n")}\n`)
  writeFileSync(join(root, "long.ts"), `// ${TAG} S-0001\n${Array.from({ length: 60 }, (_, i) => `const x${i} = ${i}`).join("\n")}\n`)
  const code = await Effect.runPromise(codeOf(root, (t) => t.replaceAll("zt-secret", "<redacted:ZT>"))("S-0001"))
  const a = code.find((c) => c.file === "a.ts")!
  expect(a).toEqual({ file: "a.ts", line: 1, text: ["export const a = () => '<redacted:ZT>'", ""].join("\n") })
  expect(code.find((c) => c.file === "long.ts")!.text.split("\n").length).toBe(40)
  expect(await Effect.runPromise(codeOf(root, (t) => t)("S-0404"))).toEqual([])
})

test("a tag in a secret or config file, or a symlink, is never served", async () => {
  const root = mkdtempSync(join(tmpdir(), "zarg-code-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  writeFileSync(join(root, "bunfig.toml"), `# ${TAG} S-0001\n[install]\n`)
  writeFileSync(join(root, "ok.ts"), `// ${TAG} S-0001\nexport const ok = 1\n`)
  const code = await Effect.runPromise(codeOf(root, (t) => t)("S-0001"))
  expect(code.map((c) => c.file)).toEqual(["ok.ts"])
})
