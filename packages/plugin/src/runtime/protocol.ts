/** Host → plugin process. */
export type ToPlugin =
  | { readonly type: "load"; readonly bundle: string }
  | { readonly type: "call"; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly type: "cancel"; readonly id: number }
  | { readonly type: "power-reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "power-reply"; readonly id: number; readonly ok: false; readonly error: Failure }

/** Plugin process → host. */
export type FromPlugin =
  | { readonly type: "ready" }
  /** Loaded; with what the bundle says it is, for the host to compare with the manifest. */
  | { readonly type: "loaded"; readonly identity: Identity }
  | { readonly type: "load-failed"; readonly message: string }
  | { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "reply"; readonly id: number; readonly ok: false; readonly error: Failure }
  | { readonly type: "chunk"; readonly id: number; readonly value: unknown }
  | { readonly type: "end"; readonly id: number }
  | { readonly type: "power"; readonly id: number; readonly power: string; readonly args: unknown }

export interface Failure {
  readonly tag: "NotGranted" | "PluginError" | "UnknownMethod"
  readonly message: string
}

export interface Identity {
  readonly name?: string
  readonly service?: string
  readonly archetype?: string
}
