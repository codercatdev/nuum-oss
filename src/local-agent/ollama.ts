/**
 * Ollama HTTP client for the local agent runner.
 *
 * Uses Ollama's native /api/chat endpoint (not the OpenAI-compatible /v1).
 * Phase 1 uses /v1 via Vercel AI SDK; this client talks directly to Ollama
 * for the local agent runner's needs (tool calling, usage tracking).
 */

import type {
  OllamaMessage,
  OllamaTool,
  OllamaChatResponse,
  OllamaToolCall,
  RunnerConfig,
} from './types'

/**
 * Usage statistics from an Ollama chat call.
 */
export interface OllamaUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  totalDurationMs: number
}

/**
 * Result of an Ollama chat call.
 * Normalizes the raw response into a consistent format.
 */
export interface OllamaChatResult {
  /** The assistant's response message */
  message: OllamaMessage
  /** Tool calls with guaranteed IDs (generated if Ollama doesn't provide them) */
  toolCalls: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  /** Whether the response is complete */
  done: boolean
  /** Token usage statistics */
  usage: OllamaUsage
}

/**
 * Ollama client error with actionable message.
 */
export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'connection_failed'
      | 'model_not_found'
      | 'request_failed'
      | 'invalid_response',
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

/**
 * Create an Ollama chat client.
 *
 * @param config - Runner configuration (ollamaBaseUrl, model, contextWindow, temperature)
 * @returns Object with chat() method
 */
export function createOllamaClient(
  config: Pick<RunnerConfig, 'ollamaBaseUrl' | 'model' | 'contextWindow' | 'temperature'>,
) {
  const baseUrl = config.ollamaBaseUrl.replace(/\/+$/, '') // strip trailing slashes

  /**
   * Send a chat request to Ollama.
   *
   * @param messages - Conversation history
   * @param tools - Available tools (optional)
   * @returns Normalized chat result with guaranteed tool call IDs
   */
  async function chat(
    messages: OllamaMessage[],
    tools?: OllamaTool[],
  ): Promise<OllamaChatResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: false,
      options: {
        num_ctx: config.contextWindow,
        temperature: config.temperature,
      },
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      })
    } catch (err: unknown) {
      const error = err as Error
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch failed')) {
        throw new OllamaError(
          `Cannot connect to Ollama at ${baseUrl}. Is it running?\n` +
            `  Start Ollama: ollama serve\n` +
            `  Or set OLLAMA_BASE_URL if running on a different host.`,
          'connection_failed',
          err,
        )
      }
      throw new OllamaError(
        `Failed to connect to Ollama at ${baseUrl}: ${error.message}`,
        'connection_failed',
        err,
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 404 || text.includes('not found')) {
        throw new OllamaError(
          `Model "${config.model}" not found in Ollama.\n` +
            `  Pull it with: ollama pull ${config.model}\n` +
            `  Or set a different model via OLLAMA_MODEL or AGENT_MODEL_WORKHORSE.`,
          'model_not_found',
        )
      }
      throw new OllamaError(
        `Ollama request failed (${response.status}): ${text}`,
        'request_failed',
      )
    }

    let data: OllamaChatResponse
    try {
      data = (await response.json()) as OllamaChatResponse
    } catch (err) {
      throw new OllamaError('Invalid JSON response from Ollama', 'invalid_response', err)
    }

    // Normalize tool calls — generate IDs since Ollama doesn't provide them
    const toolCalls = (data.message.tool_calls ?? []).map((tc: OllamaToolCall) => ({
      id: tc.id ?? `tc_${randomId()}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))

    // Extract usage statistics
    const usage: OllamaUsage = {
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      totalDurationMs: data.total_duration ? Math.round(data.total_duration / 1_000_000) : 0,
    }

    return {
      message: data.message,
      toolCalls,
      done: data.done,
      usage,
    }
  }

  return {chat}
}

/**
 * Build an Ollama tool result message.
 *
 * Ollama requires `tool_name` on tool result messages (unlike OpenAI format).
 * This helper ensures the correct format.
 */
export function buildToolResultMessage(toolName: string, result: unknown): OllamaMessage {
  // Ollama expects content as a string
  const content = typeof result === 'string' ? result : JSON.stringify(result)
  return {
    role: 'tool' as const,
    content,
    // Note: Ollama's API expects tool_name at the message level,
    // but our OllamaMessage type doesn't include it yet.
    // We add it as an extra field — TypeScript won't complain at runtime.
    ...({tool_name: toolName} as Record<string, string>),
  }
}

/**
 * Generate a short random ID for tool calls.
 */
function randomId(): string {
  // Use crypto.randomUUID if available, otherwise fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}
