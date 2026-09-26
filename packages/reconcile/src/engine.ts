import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"

/** Durable workflows on one process, stored in SQLite at `file` (for the core: `.zarg/run/cluster.db`). */
export const engineLayer = (file: string) => {
  mkdirSync(dirname(file), { recursive: true })
  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" })),
    Layer.provide(SqliteClient.layer({ filename: file })),
    Layer.provide(BunServices.layer),
  )
}
