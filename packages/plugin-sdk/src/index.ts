// What a plugin imports: bundled into the plugin, so no Node built-ins here. Build and test tools are in "./tools".
export * from "./define"
export * from "./services"
export * from "./contract"
export { type EntityDecl, type EntityHandlers, type EntityOp, entitiesProblem, opsOf } from "./entities"
export { defineView, type Surface } from "@zarg/view"
