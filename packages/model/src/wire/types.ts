import { Data } from "effect"

export interface ToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export interface ToolDef {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments. */
  readonly parameters: unknown
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string | null
  readonly reasoningContent?: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
  readonly toolCallId?: string
  readonly name?: string
}

export interface Usage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens: number
  readonly cacheHitTokens: number
  readonly cacheMissTokens: number
  /** Provider-reported cost in USD (OpenRouter's usage.cost), when present. */
  readonly costUsd?: number
  /** False when the provider omitted or garbled the token counters. */
  readonly tokenCountsComplete?: boolean
}

export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "toolCall"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: Usage }
  /** `finishReason` is absent when the provider did not say; it is never defaulted. */
  | { readonly type: "done"; readonly finishReason?: string }

export interface WireRequest {
  readonly model: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<ToolDef>
  readonly maxTokens?: number
  readonly temperature?: number
  /** OpenRouter's unified reasoning field; the router translates it per backend. */
  readonly reasoning?: { readonly effort?: string; readonly enabled?: boolean }
  /** Strict JSON-schema response (no tools allowed). */
  readonly outputSchema?: Record<string, unknown>
}

/** What a provider's /models row tells us about a model. Never guessed. */
export interface ModelInfo {
  readonly id: string
  readonly contextLength: number
  readonly maxOutputTokens: number | undefined
  readonly supportsTools: boolean
  readonly reasoningEfforts: ReadonlyArray<string>
  /** zarg-router extensions, e.g. "decision". */
  readonly capabilities: ReadonlyArray<string>
  /** zarg-router warm state ("cold", "warm", ...), when reported. */
  readonly state: string | undefined
}

export type ModelErrorKind = "transport" | "status" | "timeout" | "first-output" | "stream" | "limits" | "config"

export class ModelError extends Data.TaggedError("ModelError")<{
  readonly kind: ModelErrorKind
  readonly message: string
  readonly status?: number
}> {}
