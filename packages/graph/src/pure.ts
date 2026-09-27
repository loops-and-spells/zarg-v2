/** What a plugin bundle may use: no Node built-ins (hashing and the store stay in "@zarg/graph"). */
export * from "./diff"
export * from "./node"
export * as Snapshot from "./snapshot"
export { Put, Remove, type Change } from "./snapshot"
