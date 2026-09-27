import { Context, type Effect, type Schema } from "effect"
import type { PluginFailure } from "./services"

export type ContractMethods = Readonly<Record<string, { readonly params: Schema.Codec<any, any>; readonly success: Schema.Codec<any, any> }>>
export type ContractShape<M extends ContractMethods> = {
  readonly [K in keyof M]: (p: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, PluginFailure>
}

/** What a plugin reads of another: its name, the methods it may call and their Schemas, and the service tag. */
export interface Contract<M extends ContractMethods = ContractMethods> extends Context.Key<any, ContractShape<M>> {
  readonly pluginName: string
  readonly methods: M
}

/**
 * A plugin's public read surface for other plugins, as an Effect service tag:
 * `class Gherkin extends pluginContract("gherkin", { stories: { params, success } }) {}`.
 * Code-free (Schemas only), so dependents import it without the plugin.
 */
export const pluginContract = <const M extends ContractMethods>(name: string, methods: M) => {
  const Tag = Context.Service<any, ContractShape<M>>()(`@zarg/plugin-contract/${name}`)
  return Object.assign(Tag, { pluginName: name, methods }) as typeof Tag & { readonly pluginName: string; readonly methods: M }
}
