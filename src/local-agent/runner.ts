/**
 * Local Agent Runner — the core agent loop.
 *
 * Replaces Singular (nuum.dev) for local development.
 * Receives a ChorusPayload, runs the Ollama-powered agent loop,
 * and posts events back via the HMAC-authenticated callback URL.
 *
 * Flow:
 * 1. Send lifecycle:processing
 * 2. Discover tools from MCP servers + direct tools
 * 3. Build initial conversation (system prompt + user message)
 * 4. Loop: call Ollama → handle response (text or tool calls)
 * 5. Send lifecycle:idle (always, even on error — in finally block)
 */

import type {
  ChorusPayload,
  CallbackEvent,
  OllamaMessage,
  OllamaTool,
  RunnerConfig,
} from './types'
import {DEFAULT_RUNNER_CONFIG} from './types'
import {createOllamaClient, buildToolResultMessage, type OllamaUsage} from './ollama'
import {buildToolRegistry, executeTool, type ToolRegistry} from './tool-converter'

// ─── Callback Helper ───

/**
 * POST an event to the Chorus callback URL.
 *
 * Never throws — logs errors but doesn't crash the runner.
 * If miriad-redux is down, the agent loop should still complete.
 */
export async function postCallback(
  callbackUrl: string,
  event: CallbackEvent,
): Promise<boolean> {
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(event),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[local-agent] Callback failed (${response.status}): ${text}`)
      return false
    }
    return true
  } catch (err: unknown) {
    const error = err as Error
    console.error(`[local-agent] Callback error: ${error.message}`)
    return false
  }
}

// ─── Runner ───

/**
 * Run result returned after the agent loop completes.
 */
export interface RunResult {
  /** Whether the run completed successfully */
  success: boolean
  /** Number of loop iterations executed */
  iterations: number
  /** Total token usage across all Ollama calls */
  usage: OllamaUsage
  /** Any warnings from tool discovery */
  warnings: string[]
  /** Error message if the run failed */
  error?: string
}

/**
 * Run the local agent loop for a Chorus payload.
 *
 * This is the main entry point. It:
 * 1. Sends lifecycle:processing
 * 2. Discovers tools from MCP servers + direct tools
 * 3. Builds the conversation (system prompt + user message)
 * 4. Loops: calls Ollama, handles text responses and tool calls
 * 5. Sends lifecycle:idle (always, in finally block)
 *
 * Fire-and-forget safe — never throws. Errors are reported via
 * callback and returned in RunResult.
 */
export async function runLocalAgent(
  payload: ChorusPayload,
  config: RunnerConfig = DEFAULT_RUNNER_CONFIG,
): Promise<RunResult> {
  const {callback, channel, message, mcp, directTools} = payload

  // Aggregate usage across all Ollama calls
  const totalUsage: OllamaUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalDurationMs: 0,
  }
  let iterations = 0
  const warnings: string[] = []

  try {
    // 1. Signal processing started
    await postCallback(callback, {type: 'lifecycle', status: 'processing'})

    // 2. Discover tools
    const {registry, tools, warnings: toolWarnings} = await buildToolRegistry(
      mcp,
      directTools,
    )
    warnings.push(...toolWarnings)

    // Log tool discovery results
    console.log(
      `[local-agent] Discovered ${tools.length} tools` +
        (toolWarnings.length > 0 ? ` (${toolWarnings.length} warnings)` : ''),
    )

    // 3. Create Ollama client
    const client = createOllamaClient(config)

    // 4. Build initial conversation
    const messages: OllamaMessage[] = [
      {role: 'system', content: channel.prompt},
      {role: 'user', content: message.content},
    ]

    // 5. Agent loop
    for (iterations = 0; iterations < config.maxIterations; iterations++) {
      // Call Ollama
      const result = await client.chat(messages, tools.length > 0 ? tools : undefined)

      // Accumulate usage
      totalUsage.promptTokens += result.usage.promptTokens
      totalUsage.completionTokens += result.usage.completionTokens
      totalUsage.totalTokens += result.usage.totalTokens
      totalUsage.totalDurationMs += result.usage.totalDurationMs

      // Handle text response
      if (result.message.content && result.message.content.trim().length > 0) {
        await postCallback(callback, {
          type: 'message',
          content: result.message.content,
        })
      }

      // Handle tool calls
      if (result.toolCalls.length > 0) {
        // Add assistant message to conversation history
        messages.push(result.message)

        for (const toolCall of result.toolCalls) {
          // Post tool_call event to callback
          await postCallback(callback, {
            type: 'tool_call',
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          })

          // Execute the tool
          const toolResult = await executeTool(registry, toolCall.name, toolCall.arguments)

          // Post tool_result event to callback
          await postCallback(callback, {
            type: 'tool_result',
            result: toolResult.content,
          })

          // Add tool result to conversation for next iteration
          messages.push(buildToolResultMessage(toolCall.name, toolResult.content))
        }

        // Continue loop — Ollama will process tool results
        continue
      }

      // No tool calls and we got a response — we're done
      break
    }

    // Check if we hit the iteration limit
    if (iterations >= config.maxIterations) {
      const msg = `Agent loop reached maximum iterations (${config.maxIterations})`
      console.warn(`[local-agent] ${msg}`)
      await postCallback(callback, {type: 'error', message: msg})
    }

    return {
      success: true,
      iterations: iterations + 1,
      usage: totalUsage,
      warnings,
    }
  } catch (err: unknown) {
    const error = err as Error
    console.error(`[local-agent] Agent error: ${error.message}`)

    // Report error via callback
    await postCallback(callback, {
      type: 'error',
      message: error.message,
    })

    return {
      success: false,
      iterations,
      usage: totalUsage,
      warnings,
      error: error.message,
    }
  } finally {
    // ALWAYS send idle — this is the error contract
    // miriad-redux needs to know the agent stopped, even on crashes
    await postCallback(callback, {
      type: 'lifecycle',
      status: 'idle',
      usage: {
        byModel: {
          [config.model]: {
            promptTokens: totalUsage.promptTokens,
            completionTokens: totalUsage.completionTokens,
          },
        },
        totalTokens: totalUsage.totalTokens,
      },
    })
  }
}
