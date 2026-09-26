import type { ServiceFailure } from "./service"

/** Host → worker. */
export type ToWorker =
  | { readonly type: "init"; readonly services: Readonly<Record<string, ReadonlyArray<string>>> }
  | { readonly type: "run"; readonly id: number; readonly body: string }
  | { readonly type: "interrupt"; readonly id: number }
  | { readonly type: "reply"; readonly callId: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "reply"; readonly callId: number; readonly ok: false; readonly error: ServiceFailure }

/** Worker → host. */
export type FromWorker =
  | { readonly type: "ready" }
  | { readonly type: "call"; readonly runId: number; readonly callId: number; readonly service: string; readonly method: string; readonly params: unknown }
  | { readonly type: "log"; readonly runId: number; readonly line: string }
  | { readonly type: "done"; readonly id: number; readonly ok: true; readonly value: string | undefined }
  | { readonly type: "done"; readonly id: number; readonly ok: false; readonly error: string }
