/**
 * Types for the Local Agent Runner.
 *
 * These types define the Chorus protocol contract between miriad-redux
 * and the local agent runner. The runner receives a ChorusPayload via
 * HTTP POST and sends events back via the HMAC-authenticated callback URL.
 *
 * Source of truth: miriad-redux's chorus/bridge.ts and chorus/callback.ts
 */

// ─── Inbound: Chorus Payload (miriad-redux → runner) ───

/**
 * Channel context included in the Chorus payload.
 */
export interface ChorusChannel {
  /** Channel short ID */
  id: string
  /** Channel name, formatted as "#channel-name" */
  name: string
  /** Service identifier, always "Miriad" */
  service: string
  /** Assembled channel prompt (system prompt, skills, roster, etc.) */
  prompt: string
}

/**
 * Message that triggered the agent invocation.
 */
export interface ChorusMessage {
  /** Message ULID */
  id: string
  /** Sender identifier (e.g., "@username" or agent name) */
  sender: string
  /** Full message content, including attachment/secret hints if present */
  content: string
}

/**
 * MCP server configuration for tool discovery.
 */
export interface ChorusMcpServer {
  /** Server slug (e.g., "miriad", "github") */
  name: string
  /** Whether this is the primary MCP server */
  main?: boolean
  /** Full MCP server URL */
  url: string
  /** HTTP headers for authentication */
  headers: Record<string, string>
}

/**
 * Direct tool definition — a simpler REST alternative to MCP.
 * These tools are called via HTTP POST to callUrl.
 */
export interface ChorusDirectTool {
  /** Tool name (e.g., "send_message", "read") */
  name: string
  /** Human-readable description */
  description: string
  /** JSON Schema for tool arguments */
  inputSchema: Record<string, unknown>
  /** HTTP endpoint to call this tool */
  callUrl: string
  /** HTTP headers for authentication */
  headers: Record<string, string>
}

/**
 * The full Chorus payload sent from miriad-redux to the agent runner.
 *
 * This is the exact format that miriad-redux's chorus/bridge.ts POSTs
 * to the agent's connectionString. The local runner must accept this
 * format without modification.
 */
export interface ChorusPayload {
  /** Channel context */
  channel: ChorusChannel
  /** Triggering message */
  message: ChorusMessage
  /** HMAC-authenticated callback URL for posting events back */
  callback: string
  /** Available MCP servers for tool discovery */
  mcp: ChorusMcpServer[]
  /** Optional direct tools (REST-based, simpler than MCP) */
  directTools?: ChorusDirectTool[]
}

// ─── Outbound: Callback Events (runner → miriad-redux) ───

/**
 * Lifecycle event — signals agent processing state.
 * Must send 'processing' at start and 'idle' at end (even on error).
 */
export interface LifecycleEvent {
  type: 'lifecycle'
  /** Current agent state */
  status: 'processing' | 'idle'
  /** Optional usage statistics (sent with 'idle' status) */
  usage?: {
    byModel: Record<string, Record<string, unknown>>
    totalTokens: number
  }
}

/**
 * Message event — agent's text response to the user.
 */
export interface MessageEvent {
  type: 'message'
  /** Message content (markdown supported) */
  content: string
}

/**
 * Tool call event — agent requesting a tool execution.
 */
export interface ToolCallEvent {
  type: 'tool_call'
  /** Unique tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Tool arguments (object) */
  arguments: Record<string, unknown>
}

/**
 * Tool result event — result of a tool execution.
 */
export interface ToolResultEvent {
  type: 'tool_result'
  /** Tool execution result */
  result: unknown
}

/**
 * Error event — reports an error during agent execution.
 */
export interface ErrorEvent {
  type: 'error'
  /** Error message */
  message: string
}

/**
 * Union of all callback event types.
 * The runner POSTs these to the callback URL from the ChorusPayload.
 */
export type CallbackEvent =
  | LifecycleEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent

// ─── Ollama Types ───

/**
 * Ollama tool definition (OpenAI function calling format).
 * Used when calling Ollama's /api/chat endpoint with tools.
 */
export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * A tool call returned by Ollama in a chat response.
 */
export interface OllamaToolCall {
  id?: string
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

/**
 * Ollama chat message format.
 */
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
}

/**
 * Ollama /api/chat response (non-streaming).
 */
export interface OllamaChatResponse {
  model: string
  message: OllamaMessage
  done: boolean
  total_duration?: number
  prompt_eval_count?: number
  eval_count?: number
}

// ─── Runner Configuration ───

/**
 * Configuration for the local agent runner.
 */
export interface RunnerConfig {
  /** Ollama base URL (default: http://localhost:11434) */
  ollamaBaseUrl: string
  /** Ollama model to use (default: qwen2.5:14b) */
  model: string
  /** Maximum agent loop iterations (default: 50) */
  maxIterations: number
  /** Ollama context window size (default: 32768) */
  contextWindow: number
  /** Temperature for generation (default: 0.7) */
  temperature: number
  /** HTTP server port (default: 3001) */
  port: number
}

/**
 * Default runner configuration values.
 */
export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'qwen2.5:14b',
  maxIterations: 50,
  contextWindow: 32768,
  temperature: 0.7,
  port: 3001,
}

// ─── Validation ───

/**
 * Validate that a value is a valid ChorusPayload.
 * Returns an array of error messages (empty = valid).
 *
 * Used by the HTTP server to validate incoming requests
 * before passing to the runner.
 */
export function validateChorusPayload(value: unknown): string[] {
  const errors: string[] = []

  if (typeof value !== 'object' || value === null) {
    return ['Payload must be a non-null object']
  }

  const payload = value as Record<string, unknown>

  // channel validation
  if (typeof payload.channel !== 'object' || payload.channel === null) {
    errors.push('Missing or invalid "channel" object')
  } else {
    const ch = payload.channel as Record<string, unknown>
    if (typeof ch.id !== 'string' || ch.id.length === 0) errors.push('channel.id must be a non-empty string')
    if (typeof ch.name !== 'string' || ch.name.length === 0) errors.push('channel.name must be a non-empty string')
    if (typeof ch.service !== 'string') errors.push('channel.service must be a string')
    if (typeof ch.prompt !== 'string') errors.push('channel.prompt must be a string')
  }

  // message validation
  if (typeof payload.message !== 'object' || payload.message === null) {
    errors.push('Missing or invalid "message" object')
  } else {
    const msg = payload.message as Record<string, unknown>
    if (typeof msg.id !== 'string' || msg.id.length === 0) errors.push('message.id must be a non-empty string')
    if (typeof msg.sender !== 'string' || msg.sender.length === 0) errors.push('message.sender must be a non-empty string')
    if (typeof msg.content !== 'string') errors.push('message.content must be a string')
  }

  // callback validation
  if (typeof payload.callback !== 'string' || payload.callback.length === 0) {
    errors.push('Missing or invalid "callback" URL string')
  } else {
    try {
      new URL(payload.callback)
    } catch {
      errors.push('callback must be a valid URL')
    }
  }

  // mcp validation
  if (!Array.isArray(payload.mcp)) {
    errors.push('Missing or invalid "mcp" array')
  } else {
    for (let i = 0; i < payload.mcp.length; i++) {
      const server = payload.mcp[i] as Record<string, unknown>
      if (typeof server !== 'object' || server === null) {
        errors.push(`mcp[${i}] must be an object`)
        continue
      }
      if (typeof server.name !== 'string' || server.name.length === 0) errors.push(`mcp[${i}].name must be a non-empty string`)
      if (typeof server.url !== 'string' || server.url.length === 0) errors.push(`mcp[${i}].url must be a non-empty string`)
      if (typeof server.headers !== 'object' || server.headers === null) errors.push(`mcp[${i}].headers must be an object`)
    }
  }

  // directTools validation (optional)
  if (payload.directTools !== undefined) {
    if (!Array.isArray(payload.directTools)) {
      errors.push('"directTools" must be an array if present')
    } else {
      for (let i = 0; i < payload.directTools.length; i++) {
        const tool = payload.directTools[i] as Record<string, unknown>
        if (typeof tool !== 'object' || tool === null) {
          errors.push(`directTools[${i}] must be an object`)
          continue
        }
        if (typeof tool.name !== 'string' || tool.name.length === 0) errors.push(`directTools[${i}].name must be a non-empty string`)
        if (typeof tool.description !== 'string') errors.push(`directTools[${i}].description must be a string`)
        if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) errors.push(`directTools[${i}].inputSchema must be an object`)
        if (typeof tool.callUrl !== 'string' || tool.callUrl.length === 0) errors.push(`directTools[${i}].callUrl must be a non-empty string`)
        if (typeof tool.headers !== 'object' || tool.headers === null) errors.push(`directTools[${i}].headers must be an object`)
      }
    }
  }

  return errors
}
