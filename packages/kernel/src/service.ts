import type { Effect, Schema } from "effect"

/** One method a cell can call: `yield* Service.method(params)`. */
export interface MethodDef<P = any, S = any> {
  readonly doc: string
  readonly params: Schema.Codec<P, any>
  readonly success: Schema.Codec<S, any>
}

/** A yieldable service: its name as cells see it, a doc line, and its methods. */
export interface ServiceDef<M extends Record<string, MethodDef> = Record<string, MethodDef>> {
  readonly name: string
  readonly doc: string
  readonly methods: M
}

export const defineService = <const M extends Record<string, MethodDef>>(name: string, doc: string, methods: M): ServiceDef<M> => {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`service name "${name}" must be PascalCase`)
  for (const m of Object.keys(methods)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(m)) throw new Error(`method "${name}.${m}" must be camelCase`)
  }
  return { name, doc, methods }
}

/** What crosses the kernel boundary when a method fails: a tag the cell can `catchTag` on, and a message. */
export interface ServiceFailure {
  readonly _tag: string
  readonly message: string
}

/** Host-side implementation of a service definition. */
export type Handlers<M extends Record<string, MethodDef>> = {
  readonly [K in keyof M]: (params: Schema.Schema.Type<M[K]["params"]>) => Effect.Effect<Schema.Schema.Type<M[K]["success"]>, ServiceFailure>
}

/** A service definition paired with its host implementation. */
export interface Bound {
  readonly def: ServiceDef
  readonly handlers: Readonly<Record<string, (params: any) => Effect.Effect<unknown, ServiceFailure>>>
}

export const bind = <M extends Record<string, MethodDef>>(def: ServiceDef<M>, handlers: Handlers<M>): Bound => ({
  def,
  handlers: handlers as Bound["handlers"],
})
