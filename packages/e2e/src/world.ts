import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** The zarg checkout the suite tests. */
export const REPO = join(import.meta.dir, "..", "..", "..")
export const MAIN = join(REPO, "packages", "cli", "src", "main.ts")

export interface World {
  readonly project: string
  readonly userDir: string
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  /** Removes the world, or keeps it (a failed journey) and says where. */
  readonly dispose: (keep: boolean) => void
}

const IDENTITY = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@zarg.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@zarg.invalid" }

/** A brand-new project: a git repo with the seed files in its first commit, its own user dir and home, and nothing else from this machine's environment. */
export const world = (seed: Readonly<Record<string, string>> = {}): World => {
  const base = mkdtempSync(join(tmpdir(), "zarg-e2e-"))
  const project = join(base, "project")
  const userDir = join(base, "user")
  const home = join(base, "home")
  for (const d of [project, userDir, home]) mkdirSync(d)
  const env = { PATH: process.env.PATH ?? "", HOME: home, ZARG_USER_DIR: userDir, TERM: "xterm-256color", ...IDENTITY }
  const git = (...args: Array<string>) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: project, env })
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`)
  }
  git("init", "-q")
  for (const [path, text] of Object.entries(seed)) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), text)
  }
  git("add", "-A")
  git("commit", "-q", "--allow-empty", "-m", "init")
  return {
    project,
    userDir,
    home,
    env,
    dispose: (keep) => (keep ? console.error(`kept world: ${project}`) : rmSync(base, { recursive: true, force: true })),
  }
}

export type Ran = { readonly code: number; readonly out: string; readonly err: string; readonly json: unknown }
/** `zarg <args>` in the world's project. */
export const cli = async (w: World, args: ReadonlyArray<string>): Promise<Ran> => {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: w.project, env: w.env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  let json: unknown
  try {
    json = JSON.parse(out)
  } catch {
    json = undefined
  }
  return { code, out, err, json }
}
