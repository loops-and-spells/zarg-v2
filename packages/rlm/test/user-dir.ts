// Tests never touch the developer's ~/.config/zarg: grants and installed plugins go to a temp dir (children inherit it).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.ZARG_USER_DIR ??= mkdtempSync(join(tmpdir(), "zt-user-"))
