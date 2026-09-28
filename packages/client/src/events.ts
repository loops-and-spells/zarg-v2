/** An AG-UI event as core sends it: the event plus its thread and sequence number. */
export interface WireEvent {
  readonly type: string
  readonly threadId: string
  readonly seq: number
  readonly [key: string]: unknown
}

export interface Option {
  readonly id: string
  readonly label: string
  readonly recommended?: boolean
  readonly why?: string
}

/** Answer to an inquiry: one of its options, or the operator's own text. */
export type Answer = { readonly choice: string } | { readonly other: string }
