import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { PLUGIN_NAME } from "../runtime"
import { bundleHash } from "./first-party"
import { BUNDLE_FILE, loadPluginDir, MANIFEST_FILE } from "./loaded"
import { PluginConfigError } from "./validate"

/**
 * Install a built plugin from a directory or a `.tgz` (npm's layout: files under `package/`) into
 * `<userDir>/plugins/<name>/<sha256>/`, and make it the current version. Only the bundle and manifest are
 * copied: no package scripts run and no dependencies install (a plugin's dependencies are in its bundle).
 */
// @card UX-0060
export const installPlugin = (source: string, userDir: string): Effect.Effect<{ readonly name: string; readonly dir: string }, PluginConfigError> =>
  Effect.gen(function* () {
    let root = source
    let unpacked: string | undefined
    if (existsSync(source) && statSync(source).isFile()) {
      unpacked = mkdtempSync(join(tmpdir(), "zarg-plugin-"))
      // tar only extracts: it never runs anything the archive contains.
      const tar = Bun.spawnSync(["tar", "-xzf", source, "-C", unpacked])
      if (tar.exitCode !== 0) return yield* Effect.fail(new PluginConfigError(`${source}: not a .tgz archive (${tar.stderr.toString().trim()})`))
      root = existsSync(join(unpacked, "package", MANIFEST_FILE)) ? join(unpacked, "package") : unpacked
    }
    try {
      // The installed copy must be the files themselves: a symlink could change after the hash is taken.
      for (const f of [MANIFEST_FILE, BUNDLE_FILE]) {
        const at = join(root, f)
        if (existsSync(at) && lstatSync(at).isSymbolicLink()) return yield* Effect.fail(new PluginConfigError(`${source}: ${f} is a symlink; a plugin must ship the file itself`))
      }
      const plugin = yield* loadPluginDir(root)
      const name = plugin.manifest.name
      if (!PLUGIN_NAME.test(String(name))) return yield* Effect.fail(new PluginConfigError(`${source}: plugin name "${name}" must be kebab-case, with no doubled or trailing dash`))
      const sha = bundleHash(plugin.bundle)
      const dir = join(userDir, "plugins", name, sha)
      mkdirSync(dir, { recursive: true })
      for (const f of [MANIFEST_FILE, BUNDLE_FILE]) copyFileSync(join(root, f), join(dir, f))
      writeFileSync(join(userDir, "plugins", name, "current"), `${sha}\n`)
      return { name, dir }
    } finally {
      if (unpacked !== undefined) rmSync(unpacked, { recursive: true, force: true })
    }
  })
