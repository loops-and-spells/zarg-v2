import { Data } from "effect"

export class InvalidNode extends Data.TaggedError("InvalidNode")<{
  readonly file: string
  readonly message: string
}> {}

export class DanglingEdge extends Data.TaggedError("DanglingEdge")<{
  readonly from: string
  readonly type: string
  readonly to: string
}> {}

export class StaleNode extends Data.TaggedError("StaleNode")<{
  readonly id: string
  readonly expected: string
  readonly actual: string | undefined
}> {}

export class IoError extends Data.TaggedError("IoError")<{
  readonly path: string
  readonly message: string
}> {}

export type GraphError = InvalidNode | DanglingEdge | StaleNode | IoError
