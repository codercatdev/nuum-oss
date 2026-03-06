/**
 * Tool converter for the local agent runner.
 *
 * Bridges two tool ecosystems to Ollama's format:
 * 1. Chorus direct tools (REST) — from ChorusPayload.directTools
 * 2. MCP tools (JSON-RPC) — discovered from ChorusPayload.mcp servers
 *
 * Also handles tool execution: routing calls to the correct endpoint
 * (direct tool callUrl or MCP server) based on tool origin.
 */

import type {
  ChorusDirectTool,
  ChorusMcpServer,
  OllamaTool,
} from './types'

// ─── Tool Registry ───

/**
 * A resolved tool with its execution context.
 * Tracks where the tool came from so we can route calls correctly.
 */
export interface ResolvedTool {
  /** Ollama-format tool definition */
  tool: OllamaTool
  /** How to execute this tool */
  source:
    | {type: 'direct'; callUrl: string; headers: Record<string, string>}
    | {type: 'mcp'; serverUrl: string; headers: Record<string, string>}
}

/**
 * Registry of all available tools, indexed by name.
 */
export type ToolRegistry = Map<string, ResolvedTool>

// ─── Direct Tool Conversion ───

/**
 * Convert a Chorus direct tool to Ollama format.
 *
 * Direct tools already have name, description, and inputSchema —
 * just need to wrap in Ollama's function calling format.
 */
export function directToolToOllama(tool: ChorusDirectTool): OllamaTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

/**
 * Register direct tools into the registry.
 */
export function registerDirectTools(
  tools: ChorusDirectTool[],
  registry: ToolRegistry,
): void {
  for (const tool of tools) {
    registry.set(tool.name, {
      tool: directToolToOllama(tool),
      source: {
        type: 'direct',
        callUrl: tool.callUrl,
        headers: tool.headers,
      },
    })
  }
}

// ─── MCP Tool Discovery ───

/**
 * MCP JSON-RPC request format.
 */
interface McpRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

/**
 * MCP tool definition from tools/list response.
 */
interface McpToolDefinition {
  name: string
  description?: string
  title?: string
  inputSchema?: Record<string, unknown>
}

/**
 * MCP JSON-RPC response format.
 */
interface McpResponse {
  jsonrpc: '2.0'
  id: number
  result?: {
    tools?: McpToolDefinition[]
    content?: Array<{type: string; text?: string}>
    structuredContent?: unknown
    isError?: boolean
    nextCursor?: string
  }
  error?: {
    code: number
    message: string
  }
}

/**
 * Convert an MCP tool definition to Ollama format.
 */
export function mcpToolToOllama(tool: McpToolDefinition): OllamaTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      parameters: tool.inputSchema ?? {type: 'object', properties: {}},
    },
  }
}

/**
 * Discover tools from an MCP server via JSON-RPC tools/list.
 *
 * Handles pagination (nextCursor) to get all tools.
 * Logs warnings on failure but doesn't throw — a failed MCP server
 * shouldn't prevent the agent from running with other tools.
 */
export async function discoverMcpTools(
  server: ChorusMcpServer,
): Promise<{tools: McpToolDefinition[]; error?: string}> {
  const allTools: McpToolDefinition[] = []
  let cursor: string | undefined
  let requestId = 1

  try {
    do {
      const request: McpRequest = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/list',
        ...(cursor ? {params: {cursor}} : {}),
      }

      const response = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...server.headers,
        },
        body: JSON.stringify(request),
      })

      if (!response.ok) {
        return {
          tools: allTools,
          error: `MCP server "${server.name}" returned ${response.status}`,
        }
      }

      const data = (await response.json()) as McpResponse

      if (data.error) {
        return {
          tools: allTools,
          error: `MCP server "${server.name}" error: ${data.error.message}`,
        }
      }

      if (data.result?.tools) {
        allTools.push(...data.result.tools)
      }

      cursor = data.result?.nextCursor
    } while (cursor)
  } catch (err: unknown) {
    const error = err as Error
    return {
      tools: allTools,
      error: `Failed to connect to MCP server "${server.name}": ${error.message}`,
    }
  }

  return {tools: allTools}
}

/**
 * Discover and register tools from all MCP servers.
 *
 * Processes servers in parallel. Failures are logged but don't
 * prevent other servers from being discovered.
 */
export async function registerMcpTools(
  servers: ChorusMcpServer[],
  registry: ToolRegistry,
): Promise<string[]> {
  const warnings: string[] = []

  const results = await Promise.all(
    servers.map(async (server) => {
      const {tools, error} = await discoverMcpTools(server)
      return {server, tools, error}
    }),
  )

  for (const {server, tools, error} of results) {
    if (error) {
      warnings.push(error)
    }
    for (const tool of tools) {
      // Prefix MCP tool names with server name to avoid collisions
      // unless it's the main server (miriad tools are unprefixed)
      const toolName = server.main ? tool.name : `${server.name}__${tool.name}`
      registry.set(toolName, {
        tool: {
          ...mcpToolToOllama(tool),
          function: {
            ...mcpToolToOllama(tool).function,
            name: toolName,
          },
        },
        source: {
          type: 'mcp',
          serverUrl: server.url,
          headers: server.headers,
        },
      })
    }
  }

  return warnings
}

// ─── Tool Execution ───

/**
 * Result of executing a tool.
 */
export interface ToolResult {
  /** The tool's output */
  content: unknown
  /** Whether the tool execution failed */
  isError: boolean
}

/**
 * Execute a tool call by routing to the correct endpoint.
 *
 * - Direct tools: POST to callUrl with { tool, args }
 * - MCP tools: JSON-RPC tools/call to server URL
 *
 * Never throws — returns an error ToolResult on failure.
 */
export async function executeTool(
  registry: ToolRegistry,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = registry.get(toolName)
  if (!resolved) {
    return {
      content: `Unknown tool: "${toolName}". Available tools: ${Array.from(registry.keys()).join(', ')}`,
      isError: true,
    }
  }

  try {
    if (resolved.source.type === 'direct') {
      return await executeDirectTool(resolved.source, toolName, args)
    } else {
      // For MCP tools, strip the server prefix to get the original tool name
      const originalName = toolName.includes('__')
        ? toolName.split('__').slice(1).join('__')
        : toolName
      return await executeMcpTool(resolved.source, originalName, args)
    }
  } catch (err: unknown) {
    const error = err as Error
    return {
      content: `Tool "${toolName}" failed: ${error.message}`,
      isError: true,
    }
  }
}

/**
 * Execute a direct tool via REST POST.
 */
async function executeDirectTool(
  source: {callUrl: string; headers: Record<string, string>},
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await fetch(source.callUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...source.headers,
    },
    body: JSON.stringify({tool: toolName, args}),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      content: `Direct tool "${toolName}" returned ${response.status}: ${text}`,
      isError: true,
    }
  }

  const data = await response.json()
  // Direct tools return { result: ... } or { error: string }
  if (data.error) {
    return {content: data.error, isError: true}
  }
  return {content: data.result ?? data, isError: false}
}

/**
 * Execute an MCP tool via JSON-RPC tools/call.
 */
async function executeMcpTool(
  source: {serverUrl: string; headers: Record<string, string>},
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const request: McpRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {name: toolName, arguments: args},
  }

  const response = await fetch(source.serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...source.headers,
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      content: `MCP tool "${toolName}" returned ${response.status}: ${text}`,
      isError: true,
    }
  }

  const data = (await response.json()) as McpResponse

  if (data.error) {
    return {
      content: `MCP error: ${data.error.message}`,
      isError: true,
    }
  }

  // MCP returns content as array of {type, text} objects
  // Also may have structuredContent
  if (data.result?.structuredContent) {
    return {content: data.result.structuredContent, isError: data.result.isError ?? false}
  }

  if (data.result?.content) {
    // Extract text from content array
    const textParts = data.result.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
    const text = textParts.join('\n')
    return {content: text || data.result.content, isError: data.result.isError ?? false}
  }

  return {content: data.result, isError: false}
}

// ─── High-Level API ───

/**
 * Build a complete tool registry from a Chorus payload's tools.
 *
 * Discovers MCP tools from all servers and registers direct tools.
 * Returns the registry and any warnings from MCP discovery.
 */
export async function buildToolRegistry(
  mcpServers: ChorusMcpServer[],
  directTools?: ChorusDirectTool[],
): Promise<{registry: ToolRegistry; tools: OllamaTool[]; warnings: string[]}> {
  const registry: ToolRegistry = new Map()

  // Register direct tools first (they take priority)
  if (directTools) {
    registerDirectTools(directTools, registry)
  }

  // Discover and register MCP tools
  const warnings = await registerMcpTools(mcpServers, registry)

  // Extract OllamaTool array for passing to Ollama
  const tools = Array.from(registry.values()).map((r) => r.tool)

  return {registry, tools, warnings}
}
