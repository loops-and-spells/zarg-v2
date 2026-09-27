import { type BaseEvent, EventType, type Interrupt } from "@ag-ui/core"

/** An AG-UI event as core sends it: the event plus the thread it belongs to and its sequence number. */
export type WireEvent = BaseEvent & { readonly threadId: string; readonly seq: number; readonly [key: string]: unknown }

type Draft = { readonly type: EventType; readonly [key: string]: unknown }

export const runStarted = (threadId: string, runId: string): Draft => ({ type: EventType.RUN_STARTED, threadId, runId })

/** A zarg-specific event (AG-UI CUSTOM), e.g. `zarg.yolo` when plugins stop or start asking. */
export const custom = (name: string, value: unknown): Draft => ({ type: EventType.CUSTOM, name, value })

export const runFinished = (threadId: string, runId: string): Draft => ({ type: EventType.RUN_FINISHED, threadId, runId })

export const runInterrupted = (threadId: string, runId: string, interrupt: Interrupt): Draft => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  outcome: { type: "interrupt", interrupts: [interrupt] },
})

export const runStopped = (threadId: string, runId: string): Draft => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  outcome: { type: "cancelled" },
})

export const runError = (message: string, code: string): Draft => ({ type: EventType.RUN_ERROR, message, code })

/** A whole text message as START, CONTENT, END. */
export const textMessage = (messageId: string, role: "assistant" | "user", text: string): ReadonlyArray<Draft> => [
  { type: EventType.TEXT_MESSAGE_START, messageId, role },
  ...(text.length > 0 ? [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text }] : []),
  { type: EventType.TEXT_MESSAGE_END, messageId },
]

export const ACTIVITY_TYPE = "zarg.rlm"

export const activitySnapshot = (messageId: string, content: Record<string, unknown>, activityType = ACTIVITY_TYPE): Draft => ({
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId,
  activityType,
  content,
})

/** `content` (not in AG-UI's delta): zarg views name their agent there, so a client need not parse the message id. */
export const activityDelta = (messageId: string, patch: ReadonlyArray<Record<string, unknown>>, activityType = ACTIVITY_TYPE, content?: Record<string, unknown>): Draft => ({
  type: EventType.ACTIVITY_DELTA,
  messageId,
  activityType,
  patch,
  ...(content !== undefined ? { content } : {}),
})

export type { Draft }
