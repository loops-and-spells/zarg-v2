import { Data } from "effect"

export class EnvError extends Data.TaggedError("EnvError")<{
  readonly message: string
  readonly variable?: string
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
  readonly key?: string
  readonly file?: string
}> {}

export class SecretError extends Data.TaggedError("SecretError")<{
  readonly message: string
  readonly name?: string
}> {}
