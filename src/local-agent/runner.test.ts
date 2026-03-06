import {describe, it, expect, beforeEach, afterEach} from 'bun:test'
import {runLocalAgent, postCallback, type RunResult} from './runner'
import type {ChorusPayload, RunnerConfig} from './types'
import {DEFAULT_RUNNER_CONFIG} from './types'

// ─── Fetch Mock Infrastructure ───

const originalFetch = globalThis.fetch

interface FetchCall {
  url: string
  method: string
  body: unknown
}

/**
 * Create a fetch mock that routes requests based on URL patterns.
 *
 * Routes:
 * - /api/chat → Ollama responses (sequential from array)
 * - /chorus/callback/ → callback tracking
 * - Direct tool callUrls → direct tool responses
 * - MCP server URLs → MCP JSON-RPC responses
 */
function createFetchMock(options: {
  ollamaResponses?: Array<{
    message: {role: string; content: string; tool_calls?: any[]}
    done: boolean
    prompt_eval_count?: number
    eval_count?: number
    total_duration?: number
  }>
  ollamaError?: Error
  callbackStatus?: number
  directToolResponse?: {result?: unknown; error?: string}
  mcpToolsResponse?: {
    tools: Array<{name: string; description?: string; inputSchema?: object}>
  }
  mcpCallResponse?: {content: Array<{type: string; text?: string}>; isError?: boolean}
}) {
  const calls: FetchCall[] = []
  let ollamaCallIndex = 0

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({url, method: init?.method ?? 'GET', body})

    // Route based on URL
    if (url.includes('/api/chat')) {
      // Ollama
      if (options.ollamaError) {
        throw options.ollamaError
      }
      const responses = options.ollamaResponses ?? []
      const resp =
        responses[ollamaCallIndex] ?? responses[responses.length - 1]
      ollamaCallIndex++
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      })
    }

    if (url.includes('/chorus/callback/')) {
      // Callback
      return new Response('{}', {status: options.callbackStatus ?? 200})
    }

    // Direct tool calls — match any URL that looks like a direct tool endpoint
    // Direct tools use callUrl which could be anything, but in our tests
    // we use URLs containing /tools/call/
    if (url.includes('/tools/call/')) {
      return new Response(
        JSON.stringify(options.directToolResponse ?? {result: 'ok'}),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      )
    }

    // MCP server — match URLs containing /mcp
    if (url.includes('/mcp')) {
      // tools/list
      if (body?.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {tools: options.mcpToolsResponse?.tools ?? []},
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        )
      }
      // tools/call
      if (body?.method === 'tools/call') {
        const mcpResult = options.mcpCallResponse ?? {
          content: [{type: 'text', text: 'mcp result'}],
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: mcpResult,
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        )
      }
    }

    return new Response('Not found', {status: 404})
  }) as typeof fetch

  return {
    calls,
    getCallbackEvents: () =>
      calls
        .filter((c) => c.url.includes('/chorus/callback/'))
        .map((c) => c.body as any),
    getOllamaCalls: () => calls.filter((c) => c.url.includes('/api/chat')),
  }
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

// ─── Test Fixtures ───

function validPayload(overrides?: Partial<ChorusPayload>): ChorusPayload {
  return {
    channel: {
      id: 'ch_test',
      name: '#test',
      service: 'Miriad',
      prompt: 'You are a helpful assistant.',
    },
    message: {
      id: '01JTEST',
      sender: '@user',
      content: 'Hello!',
    },
    callback: 'http://localhost:3000/chorus/callback/hmac_token',
    mcp: [],
    directTools: [],
    ...overrides,
  }
}

const testConfig: RunnerConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'test-model',
  maxIterations: 50,
  contextWindow: 32768,
  temperature: 0.7,
  port: 3001,
}

function simpleTextResponse(
  content: string,
  promptTokens = 100,
  completionTokens = 50,
) {
  return {
    message: {role: 'assistant', content},
    done: true,
    prompt_eval_count: promptTokens,
    eval_count: completionTokens,
    total_duration: 5_000_000_000,
  }
}

function toolCallResponse(
  toolCalls: Array<{name: string; arguments: Record<string, unknown>}>,
  content = '',
) {
  return {
    message: {
      role: 'assistant',
      content,
      tool_calls: toolCalls.map((tc) => ({
        function: {name: tc.name, arguments: tc.arguments},
      })),
    },
    done: true,
    prompt_eval_count: 80,
    eval_count: 30,
    total_duration: 3_000_000_000,
  }
}

// ─── Tests ───

describe('postCallback', () => {
  afterEach(restoreFetch)

  it('returns true on successful POST', async () => {
    globalThis.fetch = (async () =>
      new Response('{}', {status: 200})) as typeof fetch
    const result = await postCallback('http://localhost:3000/chorus/callback/test', {
      type: 'message',
      content: 'hello',
    })
    expect(result).toBe(true)
  })

  it('returns false on non-ok response (case 16)', async () => {
    globalThis.fetch = (async () =>
      new Response('Server Error', {status: 500})) as typeof fetch
    const result = await postCallback('http://localhost:3000/chorus/callback/test', {
      type: 'message',
      content: 'hello',
    })
    expect(result).toBe(false)
  })

  it('returns false on network error — never throws (case 16)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const result = await postCallback('http://localhost:3000/chorus/callback/test', {
      type: 'message',
      content: 'hello',
    })
    expect(result).toBe(false)
  })

  it('sends correct Content-Type and body', async () => {
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      capturedInit = init
      return new Response('{}', {status: 200})
    }) as typeof fetch

    await postCallback('http://localhost:3000/chorus/callback/test', {
      type: 'lifecycle',
      status: 'processing',
    })

    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.headers).toEqual({'Content-Type': 'application/json'})
    const body = JSON.parse(capturedInit?.body as string)
    expect(body).toEqual({type: 'lifecycle', status: 'processing'})
  })
})

describe('runLocalAgent', () => {
  afterEach(restoreFetch)

  // ─── Basic Flow ───

  describe('basic flow', () => {
    it('case 1: simple text response — posts message + lifecycle events', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Hello! I can help you.')],
      })

      const result = await runLocalAgent(validPayload(), testConfig)

      expect(result.success).toBe(true)
      expect(result.iterations).toBe(1)

      const events = mock.getCallbackEvents()
      // Should have: lifecycle:processing, message, lifecycle:idle
      const types = events.map((e: any) => e.type)
      expect(types).toContain('lifecycle')
      expect(types).toContain('message')

      // Find the message event
      const messageEvent = events.find((e: any) => e.type === 'message')
      expect(messageEvent.content).toBe('Hello! I can help you.')
    })

    it('case 2: lifecycle:processing sent first, lifecycle:idle sent last', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Response text')],
      })

      await runLocalAgent(validPayload(), testConfig)

      const events = mock.getCallbackEvents()
      // First event must be lifecycle:processing
      expect(events[0]).toEqual({type: 'lifecycle', status: 'processing'})
      // Last event must be lifecycle:idle
      const lastEvent = events[events.length - 1]
      expect(lastEvent.type).toBe('lifecycle')
      expect(lastEvent.status).toBe('idle')
    })

    it('case 3: lifecycle:idle sent even when Ollama throws an error', async () => {
      const mock = createFetchMock({
        ollamaError: new Error('ECONNREFUSED'),
      })

      const result = await runLocalAgent(validPayload(), testConfig)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()

      const events = mock.getCallbackEvents()
      // Last event must still be lifecycle:idle
      const lastEvent = events[events.length - 1]
      expect(lastEvent.type).toBe('lifecycle')
      expect(lastEvent.status).toBe('idle')

      // Should also have an error event
      const errorEvent = events.find((e: any) => e.type === 'error')
      expect(errorEvent).toBeDefined()
    })

    it('case 4: lifecycle:idle includes usage stats', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Hello!', 200, 100)],
      })

      await runLocalAgent(validPayload(), testConfig)

      const events = mock.getCallbackEvents()
      const idleEvent = events.find(
        (e: any) => e.type === 'lifecycle' && e.status === 'idle',
      )
      expect(idleEvent).toBeDefined()
      expect(idleEvent.usage).toBeDefined()
      expect(idleEvent.usage.byModel['test-model']).toBeDefined()
      expect(idleEvent.usage.byModel['test-model'].promptTokens).toBe(200)
      expect(idleEvent.usage.byModel['test-model'].completionTokens).toBe(100)
      expect(idleEvent.usage.totalTokens).toBe(300)
    })
  })

  // ─── Tool Calling ───

  describe('tool calling', () => {
    it('case 5: single tool call — executes tool and continues', async () => {
      const payload = validPayload({
        directTools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            inputSchema: {type: 'object', properties: {city: {type: 'string'}}},
            callUrl: 'http://localhost:3000/tools/call/get_weather',
            headers: {Authorization: 'Bearer test'},
          },
        ],
      })

      const mock = createFetchMock({
        ollamaResponses: [
          // First call: Ollama requests tool
          toolCallResponse([{name: 'get_weather', arguments: {city: 'London'}}]),
          // Second call: Ollama responds with text after getting tool result
          simpleTextResponse('The weather in London is sunny!'),
        ],
        directToolResponse: {result: 'Sunny, 22°C'},
      })

      const result = await runLocalAgent(payload, testConfig)

      expect(result.success).toBe(true)
      expect(result.iterations).toBe(2) // tool call + final response

      const events = mock.getCallbackEvents()
      // Should have tool_call and tool_result events
      const toolCallEvent = events.find((e: any) => e.type === 'tool_call')
      expect(toolCallEvent).toBeDefined()
      expect(toolCallEvent.name).toBe('get_weather')
      expect(toolCallEvent.arguments).toEqual({city: 'London'})

      const toolResultEvent = events.find((e: any) => e.type === 'tool_result')
      expect(toolResultEvent).toBeDefined()
      expect(toolResultEvent.result).toBe('Sunny, 22°C')
    })

    it('case 6: multiple tool calls in one response — all executed sequentially', async () => {
      const payload = validPayload({
        directTools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            inputSchema: {type: 'object', properties: {city: {type: 'string'}}},
            callUrl: 'http://localhost:3000/tools/call/get_weather',
            headers: {},
          },
          {
            name: 'get_time',
            description: 'Get time',
            inputSchema: {type: 'object', properties: {timezone: {type: 'string'}}},
            callUrl: 'http://localhost:3000/tools/call/get_time',
            headers: {},
          },
        ],
      })

      const mock = createFetchMock({
        ollamaResponses: [
          // First call: Ollama requests two tools at once
          toolCallResponse([
            {name: 'get_weather', arguments: {city: 'London'}},
            {name: 'get_time', arguments: {timezone: 'UTC'}},
          ]),
          // Second call: Ollama responds with text
          simpleTextResponse('London is sunny and it is 3pm UTC.'),
        ],
        directToolResponse: {result: 'tool result'},
      })

      const result = await runLocalAgent(payload, testConfig)

      expect(result.success).toBe(true)

      const events = mock.getCallbackEvents()
      const toolCallEvents = events.filter((e: any) => e.type === 'tool_call')
      expect(toolCallEvents.length).toBe(2)
      expect(toolCallEvents[0].name).toBe('get_weather')
      expect(toolCallEvents[1].name).toBe('get_time')

      const toolResultEvents = events.filter((e: any) => e.type === 'tool_result')
      expect(toolResultEvents.length).toBe(2)
    })

    it('case 7: multi-turn tool calling — tool → result → tool → result → text', async () => {
      const payload = validPayload({
        directTools: [
          {
            name: 'search',
            description: 'Search the web',
            inputSchema: {type: 'object', properties: {query: {type: 'string'}}},
            callUrl: 'http://localhost:3000/tools/call/search',
            headers: {},
          },
        ],
      })

      const mock = createFetchMock({
        ollamaResponses: [
          // Turn 1: first tool call
          toolCallResponse([{name: 'search', arguments: {query: 'weather London'}}]),
          // Turn 2: second tool call (after getting first result)
          toolCallResponse([{name: 'search', arguments: {query: 'weather Paris'}}]),
          // Turn 3: final text response
          simpleTextResponse('London is sunny, Paris is rainy.'),
        ],
        directToolResponse: {result: 'search result'},
      })

      const result = await runLocalAgent(payload, testConfig)

      expect(result.success).toBe(true)
      expect(result.iterations).toBe(3)

      const events = mock.getCallbackEvents()
      const toolCallEvents = events.filter((e: any) => e.type === 'tool_call')
      expect(toolCallEvents.length).toBe(2)
      expect(toolCallEvents[0].arguments).toEqual({query: 'weather London'})
      expect(toolCallEvents[1].arguments).toEqual({query: 'weather Paris'})

      // Verify Ollama was called 3 times
      const ollamaCalls = mock.getOllamaCalls()
      expect(ollamaCalls.length).toBe(3)

      // Second Ollama call should include tool result in messages
      const secondCallMessages = ollamaCalls[1].body.messages
      expect(secondCallMessages.length).toBeGreaterThan(2) // system + user + assistant + tool
    })

    it('case 8: tool execution failure — runner continues with error result', async () => {
      const payload = validPayload({
        directTools: [
          {
            name: 'failing_tool',
            description: 'A tool that fails',
            inputSchema: {type: 'object', properties: {}},
            callUrl: 'http://localhost:3000/tools/call/failing_tool',
            headers: {},
          },
        ],
      })

      const mock = createFetchMock({
        ollamaResponses: [
          // Ollama requests the failing tool
          toolCallResponse([{name: 'failing_tool', arguments: {}}]),
          // Ollama responds with text after getting error result
          simpleTextResponse('Sorry, the tool failed.'),
        ],
        directToolResponse: {error: 'Something went wrong'},
      })

      const result = await runLocalAgent(payload, testConfig)

      // Runner should still succeed — tool failure is not a runner failure
      expect(result.success).toBe(true)

      const events = mock.getCallbackEvents()
      // Should still have tool_result event (with error content)
      const toolResultEvent = events.find((e: any) => e.type === 'tool_result')
      expect(toolResultEvent).toBeDefined()
      // The error content is passed through to the tool result
      expect(toolResultEvent.result).toBe('Something went wrong')
    })
  })

  // ─── Error Handling ───

  describe('error handling', () => {
    it('case 9: Ollama connection failure — error posted, idle still sent', async () => {
      const mock = createFetchMock({
        ollamaError: new Error('fetch failed'),
      })

      const result = await runLocalAgent(validPayload(), testConfig)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()

      const events = mock.getCallbackEvents()
      // Should have: lifecycle:processing, error, lifecycle:idle
      const errorEvent = events.find((e: any) => e.type === 'error')
      expect(errorEvent).toBeDefined()

      // lifecycle:idle must be the last event
      const lastEvent = events[events.length - 1]
      expect(lastEvent.type).toBe('lifecycle')
      expect(lastEvent.status).toBe('idle')
    })

    it('case 10: max iterations reached — warning posted, idle still sent', async () => {
      const limitedConfig: RunnerConfig = {
        ...testConfig,
        maxIterations: 2,
      }

      const payload = validPayload({
        directTools: [
          {
            name: 'loop_tool',
            description: 'A tool that keeps getting called',
            inputSchema: {type: 'object', properties: {}},
            callUrl: 'http://localhost:3000/tools/call/loop_tool',
            headers: {},
          },
        ],
      })

      const mock = createFetchMock({
        // Always return tool calls — never a plain text response
        ollamaResponses: [
          toolCallResponse([{name: 'loop_tool', arguments: {}}]),
          toolCallResponse([{name: 'loop_tool', arguments: {}}]),
          toolCallResponse([{name: 'loop_tool', arguments: {}}]),
        ],
        directToolResponse: {result: 'ok'},
      })

      const result = await runLocalAgent(payload, limitedConfig)

      // Still succeeds — max iterations is a warning, not an error
      expect(result.success).toBe(true)

      const events = mock.getCallbackEvents()
      // Should have an error event about max iterations
      const errorEvent = events.find(
        (e: any) => e.type === 'error' && e.message?.includes('maximum iterations'),
      )
      expect(errorEvent).toBeDefined()

      // lifecycle:idle must still be sent
      const lastEvent = events[events.length - 1]
      expect(lastEvent.type).toBe('lifecycle')
      expect(lastEvent.status).toBe('idle')
    })

    it('case 11: callback POST failure — logged but does not crash runner', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Hello!')],
        callbackStatus: 500,
      })

      const result = await runLocalAgent(validPayload(), testConfig)

      // Runner should still succeed even though callbacks failed
      expect(result.success).toBe(true)
      expect(result.iterations).toBe(1)
    })
  })

  // ─── Configuration ───

  describe('configuration', () => {
    it('case 12: custom config — model and settings passed to Ollama', async () => {
      const customConfig: RunnerConfig = {
        ollamaBaseUrl: 'http://custom-host:11434',
        model: 'llama3.2:3b',
        maxIterations: 10,
        contextWindow: 16384,
        temperature: 0.3,
        port: 4000,
      }

      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Custom response')],
      })

      const result = await runLocalAgent(validPayload(), customConfig)

      expect(result.success).toBe(true)

      // Verify Ollama was called with custom settings
      const ollamaCalls = mock.getOllamaCalls()
      expect(ollamaCalls.length).toBe(1)
      expect(ollamaCalls[0].url).toContain('custom-host:11434')
      expect(ollamaCalls[0].body.model).toBe('llama3.2:3b')
      expect(ollamaCalls[0].body.options.num_ctx).toBe(16384)
      expect(ollamaCalls[0].body.options.temperature).toBe(0.3)

      // Verify idle event uses custom model name
      const events = mock.getCallbackEvents()
      const idleEvent = events.find(
        (e: any) => e.type === 'lifecycle' && e.status === 'idle',
      )
      expect(idleEvent.usage.byModel['llama3.2:3b']).toBeDefined()
    })

    it('case 13: default config — DEFAULT_RUNNER_CONFIG used when not specified', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Default response')],
      })

      // Call without config — should use DEFAULT_RUNNER_CONFIG
      const result = await runLocalAgent(validPayload())

      expect(result.success).toBe(true)

      // Verify Ollama was called with default settings
      const ollamaCalls = mock.getOllamaCalls()
      expect(ollamaCalls[0].url).toContain('localhost:11434')
      expect(ollamaCalls[0].body.model).toBe(DEFAULT_RUNNER_CONFIG.model)
      expect(ollamaCalls[0].body.options.num_ctx).toBe(DEFAULT_RUNNER_CONFIG.contextWindow)
      expect(ollamaCalls[0].body.options.temperature).toBe(DEFAULT_RUNNER_CONFIG.temperature)

      // Verify idle event uses default model name
      const events = mock.getCallbackEvents()
      const idleEvent = events.find(
        (e: any) => e.type === 'lifecycle' && e.status === 'idle',
      )
      expect(idleEvent.usage.byModel[DEFAULT_RUNNER_CONFIG.model]).toBeDefined()
    })
  })

  // ─── Integration ───

  describe('integration', () => {
    it('case 14: tool discovery warnings — returned in RunResult', async () => {
      // Use an MCP server that will fail to connect
      const payload = validPayload({
        mcp: [
          {
            name: 'broken-server',
            url: 'http://localhost:9999/mcp',
            headers: {},
          },
        ],
      })

      // The MCP server fetch will return 404 (our mock default for unknown URLs)
      // Actually, let's make the MCP tools/list return an error
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Hello!')],
        mcpToolsResponse: {tools: []}, // Empty tools, but the server responds
      })

      // Override fetch to make the MCP server return an error for this specific test
      const baseFetch = globalThis.fetch
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        // Make MCP server return 500 to trigger a warning
        if (url.includes('/mcp') && url.includes('9999')) {
          return new Response('Internal Server Error', {status: 500})
        }
        return baseFetch(input, init!)
      }) as typeof fetch

      const result = await runLocalAgent(payload, testConfig)

      // Runner should still succeed
      expect(result.success).toBe(true)
      // Should have warnings about the failed MCP server
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings[0]).toContain('broken-server')
    })

    it('case 15: empty tool list — Ollama called without tools parameter', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('No tools available.')],
      })

      const result = await runLocalAgent(validPayload(), testConfig)

      expect(result.success).toBe(true)

      // Verify Ollama was called without tools
      const ollamaCalls = mock.getOllamaCalls()
      expect(ollamaCalls.length).toBe(1)
      expect(ollamaCalls[0].body.tools).toBeUndefined()
    })

    it('case 16: postCallback returns false on failure — does not throw', async () => {
      // This is tested in the postCallback unit tests above,
      // but let's also verify it in the context of the runner
      let callbackCallCount = 0
      const baseFetch = createFetchMock({
        ollamaResponses: [simpleTextResponse('Hello!')],
        callbackStatus: 500, // All callbacks fail
      })

      const result = await runLocalAgent(validPayload(), testConfig)

      // Runner should still succeed even though all callbacks returned 500
      expect(result.success).toBe(true)
      expect(result.iterations).toBe(1)
    })
  })

  // ─── Usage Accumulation ───

  describe('usage accumulation', () => {
    it('accumulates usage across multiple Ollama calls', async () => {
      const payload = validPayload({
        directTools: [
          {
            name: 'test_tool',
            description: 'Test tool',
            inputSchema: {type: 'object', properties: {}},
            callUrl: 'http://localhost:3000/tools/call/test_tool',
            headers: {},
          },
        ],
      })

      const mock = createFetchMock({
        ollamaResponses: [
          // First call: tool call (80 prompt + 30 completion)
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {function: {name: 'test_tool', arguments: {}}},
              ],
            },
            done: true,
            prompt_eval_count: 80,
            eval_count: 30,
            total_duration: 2_000_000_000,
          },
          // Second call: text response (150 prompt + 60 completion)
          {
            message: {role: 'assistant', content: 'Done!'},
            done: true,
            prompt_eval_count: 150,
            eval_count: 60,
            total_duration: 3_000_000_000,
          },
        ],
        directToolResponse: {result: 'ok'},
      })

      const result = await runLocalAgent(payload, testConfig)

      expect(result.success).toBe(true)
      expect(result.usage.promptTokens).toBe(230) // 80 + 150
      expect(result.usage.completionTokens).toBe(90) // 30 + 60
      expect(result.usage.totalTokens).toBe(320) // 230 + 90
      expect(result.usage.totalDurationMs).toBe(5000) // 2000 + 3000
    })
  })

  // ─── Conversation Building ───

  describe('conversation building', () => {
    it('builds initial conversation with system prompt and user message', async () => {
      const payload = validPayload({
        channel: {
          id: 'ch_test',
          name: '#test',
          service: 'Miriad',
          prompt: 'You are a coding assistant.',
        },
        message: {
          id: '01JTEST',
          sender: '@dev',
          content: 'Write a function',
        },
      })

      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('Here is a function...')],
      })

      await runLocalAgent(payload, testConfig)

      const ollamaCalls = mock.getOllamaCalls()
      const messages = ollamaCalls[0].body.messages
      expect(messages.length).toBe(2)
      expect(messages[0]).toEqual({
        role: 'system',
        content: 'You are a coding assistant.',
      })
      expect(messages[1]).toEqual({
        role: 'user',
        content: 'Write a function',
      })
    })

    it('does not post message event for empty/whitespace-only content', async () => {
      const mock = createFetchMock({
        ollamaResponses: [simpleTextResponse('   ')],
      })

      await runLocalAgent(validPayload(), testConfig)

      const events = mock.getCallbackEvents()
      const messageEvents = events.filter((e: any) => e.type === 'message')
      expect(messageEvents.length).toBe(0)
    })
  })

  // ─── MCP Tool Integration ───

  describe('MCP tool integration', () => {
    it('discovers and uses MCP tools', async () => {
      const payload = validPayload({
        mcp: [
          {
            name: 'github',
            url: 'http://localhost:8080/mcp',
            headers: {Authorization: 'Bearer gh_token'},
          },
        ],
      })

      const mock = createFetchMock({
        mcpToolsResponse: {
          tools: [
            {
              name: 'search_repos',
              description: 'Search GitHub repos',
              inputSchema: {
                type: 'object',
                properties: {query: {type: 'string'}},
              },
            },
          ],
        },
        ollamaResponses: [
          // Ollama calls the MCP tool (prefixed with server name)
          toolCallResponse([
            {name: 'github__search_repos', arguments: {query: 'nuum-oss'}},
          ]),
          // Ollama responds with text
          simpleTextResponse('Found the nuum-oss repo!'),
        ],
      })

      const result = await runLocalAgent(payload, testConfig)

      expect(result.success).toBe(true)

      // Verify Ollama was given the tools
      const ollamaCalls = mock.getOllamaCalls()
      expect(ollamaCalls[0].body.tools).toBeDefined()
      expect(ollamaCalls[0].body.tools.length).toBe(1)
      expect(ollamaCalls[0].body.tools[0].function.name).toBe('github__search_repos')
    })
  })
})
