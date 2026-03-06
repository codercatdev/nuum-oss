import {describe, it, expect, afterEach} from 'bun:test'
import {
  directToolToOllama,
  registerDirectTools,
  mcpToolToOllama,
  discoverMcpTools,
  registerMcpTools,
  executeTool,
  buildToolRegistry,
} from './tool-converter'
import type {ToolRegistry} from './tool-converter'
import type {ChorusDirectTool, ChorusMcpServer} from './types'

// ─── Fetch mocking helpers ───

const originalFetch = globalThis.fetch

function mockFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = handler as typeof fetch
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

// ─── Response helpers ───

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  })
}

// ─── Test fixtures ───

function makeDirectTool(overrides: Partial<ChorusDirectTool> = {}): ChorusDirectTool {
  return {
    name: 'send_message',
    description: 'Send a message to a channel',
    inputSchema: {
      type: 'object',
      properties: {
        content: {type: 'string'},
      },
      required: ['content'],
    },
    callUrl: 'https://api.example.com/tools/call',
    headers: {Authorization: 'Bearer test-token'},
    ...overrides,
  }
}

function makeMcpServer(overrides: Partial<ChorusMcpServer> = {}): ChorusMcpServer {
  return {
    name: 'miriad',
    main: true,
    url: 'https://mcp.example.com/jsonrpc',
    headers: {'X-Api-Key': 'mcp-key'},
    ...overrides,
  }
}

// ─── Tests ───

describe('tool-converter', () => {
  afterEach(() => {
    restoreFetch()
  })

  // ─── Direct Tool Conversion ───

  describe('directToolToOllama', () => {
    it('converts ChorusDirectTool to OllamaTool format', () => {
      const tool = makeDirectTool()
      const result = directToolToOllama(tool)

      expect(result).toEqual({
        type: 'function',
        function: {
          name: 'send_message',
          description: 'Send a message to a channel',
          parameters: {
            type: 'object',
            properties: {
              content: {type: 'string'},
            },
            required: ['content'],
          },
        },
      })
    })
  })

  describe('registerDirectTools', () => {
    it('registers multiple tools in registry with correct source', () => {
      const registry: ToolRegistry = new Map()
      const tools = [
        makeDirectTool({name: 'send_message'}),
        makeDirectTool({
          name: 'read_file',
          description: 'Read a file',
          callUrl: 'https://api.example.com/tools/read',
        }),
      ]

      registerDirectTools(tools, registry)

      expect(registry.size).toBe(2)
      expect(registry.has('send_message')).toBe(true)
      expect(registry.has('read_file')).toBe(true)

      const sendMsg = registry.get('send_message')!
      expect(sendMsg.source.type).toBe('direct')
      expect(sendMsg.source).toEqual({
        type: 'direct',
        callUrl: 'https://api.example.com/tools/call',
        headers: {Authorization: 'Bearer test-token'},
      })
      expect(sendMsg.tool.function.name).toBe('send_message')

      const readFile = registry.get('read_file')!
      expect(readFile.source).toEqual({
        type: 'direct',
        callUrl: 'https://api.example.com/tools/read',
        headers: {Authorization: 'Bearer test-token'},
      })
    })
  })

  // ─── MCP Tool Conversion ───

  describe('mcpToolToOllama', () => {
    it('converts MCP tool definition to OllamaTool', () => {
      const result = mcpToolToOllama({
        name: 'search',
        description: 'Search for documents',
        inputSchema: {
          type: 'object',
          properties: {query: {type: 'string'}},
        },
      })

      expect(result).toEqual({
        type: 'function',
        function: {
          name: 'search',
          description: 'Search for documents',
          parameters: {
            type: 'object',
            properties: {query: {type: 'string'}},
          },
        },
      })
    })

    it('falls back to title when description is missing', () => {
      const result = mcpToolToOllama({
        name: 'search',
        title: 'Search Tool',
      })

      expect(result.function.description).toBe('Search Tool')
    })

    it('falls back to name when both description and title are missing', () => {
      const result = mcpToolToOllama({
        name: 'search',
      })

      expect(result.function.description).toBe('search')
    })

    it('defaults to empty object schema when inputSchema is missing', () => {
      const result = mcpToolToOllama({
        name: 'search',
      })

      expect(result.function.parameters).toEqual({type: 'object', properties: {}})
    })
  })

  // ─── MCP Discovery ───

  describe('discoverMcpTools', () => {
    it('successfully discovers tools from MCP server', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              {name: 'read', description: 'Read a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}}}},
              {name: 'write', description: 'Write a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}}},
            ],
          },
        }),
      )

      const server = makeMcpServer()
      const {tools, error} = await discoverMcpTools(server)

      expect(error).toBeUndefined()
      expect(tools).toHaveLength(2)
      expect(tools[0].name).toBe('read')
      expect(tools[1].name).toBe('write')
    })

    it('handles pagination with nextCursor', async () => {
      let callCount = 0
      mockFetch((_url, init) => {
        callCount++
        const body = JSON.parse(init?.body as string)

        if (callCount === 1) {
          // First page — no cursor in request
          expect(body.params).toBeUndefined()
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              tools: [{name: 'tool_a', description: 'Tool A'}],
              nextCursor: 'page2',
            },
          })
        } else {
          // Second page — cursor should be passed
          expect(body.params.cursor).toBe('page2')
          return jsonResponse({
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [{name: 'tool_b', description: 'Tool B'}],
            },
          })
        }
      })

      const server = makeMcpServer()
      const {tools, error} = await discoverMcpTools(server)

      expect(error).toBeUndefined()
      expect(tools).toHaveLength(2)
      expect(tools[0].name).toBe('tool_a')
      expect(tools[1].name).toBe('tool_b')
      expect(callCount).toBe(2)
    })

    it('handles connection failure gracefully', async () => {
      mockFetch(() => {
        throw new Error('Connection refused')
      })

      const server = makeMcpServer()
      const {tools, error} = await discoverMcpTools(server)

      expect(tools).toEqual([])
      expect(error).toContain('Failed to connect to MCP server')
      expect(error).toContain('Connection refused')
    })

    it('handles HTTP error gracefully', async () => {
      mockFetch(() => jsonResponse({error: 'Internal Server Error'}, 500))

      const server = makeMcpServer()
      const {tools, error} = await discoverMcpTools(server)

      expect(tools).toEqual([])
      expect(error).toContain('returned 500')
    })

    it('handles JSON-RPC error gracefully', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          error: {code: -32600, message: 'Invalid Request'},
        }),
      )

      const server = makeMcpServer()
      const {tools, error} = await discoverMcpTools(server)

      expect(tools).toEqual([])
      expect(error).toContain('Invalid Request')
    })
  })

  // ─── MCP Tool Naming ───

  describe('registerMcpTools', () => {
    it('main server tools are unprefixed', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{name: 'read', description: 'Read a file'}],
          },
        }),
      )

      const registry: ToolRegistry = new Map()
      const server = makeMcpServer({name: 'miriad', main: true})
      await registerMcpTools([server], registry)

      expect(registry.has('read')).toBe(true)
      expect(registry.has('miriad__read')).toBe(false)
    })

    it('non-main server tools are prefixed with server name', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{name: 'search_code', description: 'Search code'}],
          },
        }),
      )

      const registry: ToolRegistry = new Map()
      const server = makeMcpServer({name: 'github', main: false, url: 'https://github-mcp.example.com'})
      await registerMcpTools([server], registry)

      expect(registry.has('github__search_code')).toBe(true)
      expect(registry.has('search_code')).toBe(false)

      const tool = registry.get('github__search_code')!
      expect(tool.tool.function.name).toBe('github__search_code')
    })
  })

  // ─── Tool Execution ───

  describe('executeTool', () => {
    it('executes direct tool successfully', async () => {
      mockFetch(() =>
        jsonResponse({result: 'Message sent successfully'}),
      )

      const registry: ToolRegistry = new Map()
      registry.set('send_message', {
        tool: directToolToOllama(makeDirectTool()),
        source: {
          type: 'direct',
          callUrl: 'https://api.example.com/tools/call',
          headers: {Authorization: 'Bearer test-token'},
        },
      })

      const result = await executeTool(registry, 'send_message', {content: 'Hello'})

      expect(result.isError).toBe(false)
      expect(result.content).toBe('Message sent successfully')
    })

    it('handles direct tool HTTP error', async () => {
      mockFetch(() => new Response('Server Error', {status: 500}))

      const registry: ToolRegistry = new Map()
      registry.set('send_message', {
        tool: directToolToOllama(makeDirectTool()),
        source: {
          type: 'direct',
          callUrl: 'https://api.example.com/tools/call',
          headers: {},
        },
      })

      const result = await executeTool(registry, 'send_message', {content: 'Hello'})

      expect(result.isError).toBe(true)
      expect(result.content).toContain('returned 500')
    })

    it('handles direct tool returning { error: string }', async () => {
      mockFetch(() =>
        jsonResponse({error: 'Permission denied'}),
      )

      const registry: ToolRegistry = new Map()
      registry.set('send_message', {
        tool: directToolToOllama(makeDirectTool()),
        source: {
          type: 'direct',
          callUrl: 'https://api.example.com/tools/call',
          headers: {},
        },
      })

      const result = await executeTool(registry, 'send_message', {content: 'Hello'})

      expect(result.isError).toBe(true)
      expect(result.content).toBe('Permission denied')
    })

    it('executes MCP tool successfully with text content', async () => {
      mockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string)
        // Verify the tool name sent to MCP is the original (unprefixed) name
        expect(body.params.name).toBe('search_code')
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {type: 'text', text: 'Found 3 results'},
              {type: 'text', text: 'file1.ts, file2.ts, file3.ts'},
            ],
          },
        })
      })

      const registry: ToolRegistry = new Map()
      registry.set('github__search_code', {
        tool: {
          type: 'function',
          function: {name: 'github__search_code', description: 'Search code', parameters: {}},
        },
        source: {
          type: 'mcp',
          serverUrl: 'https://github-mcp.example.com',
          headers: {'X-Api-Key': 'key'},
        },
      })

      const result = await executeTool(registry, 'github__search_code', {query: 'test'})

      expect(result.isError).toBe(false)
      expect(result.content).toBe('Found 3 results\nfile1.ts, file2.ts, file3.ts')
    })

    it('executes MCP tool with structuredContent', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            structuredContent: {files: ['a.ts', 'b.ts'], count: 2},
          },
        }),
      )

      const registry: ToolRegistry = new Map()
      registry.set('github__list_files', {
        tool: {
          type: 'function',
          function: {name: 'github__list_files', description: 'List files', parameters: {}},
        },
        source: {
          type: 'mcp',
          serverUrl: 'https://github-mcp.example.com',
          headers: {},
        },
      })

      const result = await executeTool(registry, 'github__list_files', {})

      expect(result.isError).toBe(false)
      expect(result.content).toEqual({files: ['a.ts', 'b.ts'], count: 2})
    })

    it('handles MCP tool JSON-RPC error', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          error: {code: -32600, message: 'Tool not found'},
        }),
      )

      const registry: ToolRegistry = new Map()
      registry.set('github__search_code', {
        tool: {
          type: 'function',
          function: {name: 'github__search_code', description: 'Search', parameters: {}},
        },
        source: {
          type: 'mcp',
          serverUrl: 'https://github-mcp.example.com',
          headers: {},
        },
      })

      const result = await executeTool(registry, 'github__search_code', {query: 'test'})

      expect(result.isError).toBe(true)
      expect(result.content).toContain('Tool not found')
    })

    it('returns error for unknown tool name', async () => {
      const registry: ToolRegistry = new Map()
      registry.set('send_message', {
        tool: directToolToOllama(makeDirectTool()),
        source: {type: 'direct', callUrl: 'https://example.com', headers: {}},
      })

      const result = await executeTool(registry, 'nonexistent_tool', {})

      expect(result.isError).toBe(true)
      expect(result.content).toContain('Unknown tool: "nonexistent_tool"')
      expect(result.content).toContain('send_message')
    })

    it('handles fetch failure gracefully (never throws)', async () => {
      mockFetch(() => {
        throw new Error('Network error')
      })

      const registry: ToolRegistry = new Map()
      registry.set('send_message', {
        tool: directToolToOllama(makeDirectTool()),
        source: {
          type: 'direct',
          callUrl: 'https://api.example.com/tools/call',
          headers: {},
        },
      })

      // This should NOT throw — it should return an error ToolResult
      const result = await executeTool(registry, 'send_message', {content: 'Hello'})

      expect(result.isError).toBe(true)
      expect(result.content).toContain('Network error')
    })

    it('strips prefix when calling MCP tool', async () => {
      let capturedToolName: string | undefined
      mockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string)
        capturedToolName = body.params.name
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{type: 'text', text: 'ok'}],
          },
        })
      })

      const registry: ToolRegistry = new Map()
      registry.set('github__search_code', {
        tool: {
          type: 'function',
          function: {name: 'github__search_code', description: 'Search', parameters: {}},
        },
        source: {
          type: 'mcp',
          serverUrl: 'https://github-mcp.example.com',
          headers: {},
        },
      })

      await executeTool(registry, 'github__search_code', {query: 'test'})

      // The MCP server should receive the original tool name without prefix
      expect(capturedToolName).toBe('search_code')
    })
  })

  // ─── High-Level API ───

  describe('buildToolRegistry', () => {
    it('combines direct and MCP tools', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{name: 'read', description: 'Read a file'}],
          },
        }),
      )

      const directTools = [makeDirectTool({name: 'send_message'})]
      const mcpServers = [makeMcpServer({name: 'miriad', main: true})]

      const {registry, tools, warnings} = await buildToolRegistry(mcpServers, directTools)

      expect(warnings).toEqual([])
      expect(registry.size).toBe(2)
      expect(registry.has('send_message')).toBe(true)
      expect(registry.has('read')).toBe(true)
      expect(tools).toHaveLength(2)

      // Verify tools array contains OllamaTool objects
      const toolNames = tools.map((t) => t.function.name)
      expect(toolNames).toContain('send_message')
      expect(toolNames).toContain('read')
    })

    it('returns warnings from failed MCP servers', async () => {
      mockFetch(() => {
        throw new Error('Connection refused')
      })

      const mcpServers = [makeMcpServer({name: 'broken-server'})]

      const {registry, tools, warnings} = await buildToolRegistry(mcpServers)

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('Failed to connect')
      expect(warnings[0]).toContain('broken-server')
      expect(registry.size).toBe(0)
      expect(tools).toHaveLength(0)
    })

    it('works with no direct tools', async () => {
      mockFetch(() =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{name: 'search', description: 'Search'}],
          },
        }),
      )

      const mcpServers = [makeMcpServer({name: 'miriad', main: true})]

      const {registry, tools, warnings} = await buildToolRegistry(mcpServers)

      expect(warnings).toEqual([])
      expect(registry.size).toBe(1)
      expect(registry.has('search')).toBe(true)
      expect(tools).toHaveLength(1)
    })
  })
})
