import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { Contract } from "./contract"

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

/** A digest of a contract's methods and Schemas (build time only: plugin bundles cannot hash). */
export const contractDigest = (c: Pick<Contract, "methods">) =>
  createHash("sha256")
    .update(canonical(Object.fromEntries(Object.entries(c.methods).map(([k, m]) => [k, { params: Schema.toJsonSchemaDocument(m.params), success: Schema.toJsonSchemaDocument(m.success) }]))))
    .digest("hex")
