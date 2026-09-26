import { gherkin } from "@zarg/plugin-gherkin/server"
import type { ServerPlugin } from "@zarg/plugin/server"

/** Plugins the CLI hosts. Add new plugins here. */
export const plugins: ReadonlyArray<ServerPlugin> = [gherkin]
