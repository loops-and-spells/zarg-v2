import type { ChatMessage, WireRequest } from "./types"

// Fixed key insertion order: identical requests serialize to identical bytes (prompt caches key on bytes).
const wireMessage = (m: ChatMessage): Record<string, unknown> => {
  const w: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.reasoningContent !== undefined) w.reasoning_content = m.reasoningContent
  if (m.toolCalls) {
    w.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: c.type,
      function: { name: c.function.name, arguments: c.function.arguments },
    }))
  }
  if (m.toolCallId !== undefined) w.tool_call_id = m.toolCallId
  if (m.role === "tool") {
    if (m.name === undefined) throw new Error("tool message missing name (required by strict backends)")
    w.name = m.name
  } else if (m.name !== undefined) w.name = m.name
  // Strict OpenAI-compatible servers reject a null content that is not a tool-call turn.
  if (m.content === null && !m.toolCalls) w.content = ""
  return w
}

/** OpenRouter-dialect chat-completions body. Always streams and asks for usage. */
export const buildRequestBody = (p: WireRequest): string => {
  if (!p.model) throw new Error("WireRequest.model must be set")
  const body: Record<string, unknown> = { model: p.model, messages: p.messages.map(wireMessage) }
  if (p.outputSchema) {
    if (p.tools?.length || p.outputSchema.type !== "object") {
      throw new Error("structured output requires an object schema and no tools")
    }
    body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: p.outputSchema } }
  }
  if (p.tools) {
    body.tools = p.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens
  if (p.temperature !== undefined) body.temperature = p.temperature
  body.stream = true
  body.stream_options = { include_usage: true }
  if (p.reasoning !== undefined) body.reasoning = { ...p.reasoning }
  return JSON.stringify(body)
}
