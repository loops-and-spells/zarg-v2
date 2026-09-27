import { createHash } from "node:crypto"
import { canonical, type Node } from "./node"

/** Short content hash of the canonical form. Used as the node's revision. */
export const hash = (node: Node): string =>
  createHash("sha256").update(canonical(node)).digest("hex").slice(0, 12)
