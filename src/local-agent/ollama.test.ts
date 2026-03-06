import {describe, it, expect, beforeEach, afterEach} from 'bun:test'
import {createOllamaClient, buildToolResultMessage, OllamaError} from './ollama'
import type {OllamaMessage, OllamaTool} from './types'

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

// ─── Test fixtures ───

const defaultConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'qwen2.5:14b',
  contextWindow: 32768,
  temperature: 0.7,
}

function makeOllamaResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'qwen2.5:14b',
    message: {
      role: 'assistant',
      content: 'Hello! How can I help you?',
    },
    done: true,
    total_duration: 5_000_000_000, // 5 seconds in nanoseconds
    prompt_eval_count: 100,
    eval_count: 50,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {'Content-Type': 'text/plain'},
  })
}

// ─── Tests ───

describe('createOllamaClient', () => {
  afterEach(() => {
    restoreFetch()
  })

  describe('successful chat response', () => {
    it('returns normalized result with usage stats', async () => {
      mockFetch(() => jsonResponse(makeOllamaResponse()))

      const client = createOllamaClient(defaultConfig)
      const result = await client.chat([{role: 'user', content: 'Hello'}])

      expect(result.message.role).toBe('assistant')
      expect(result.message.content).toBe('Hello! How can I help you?')
      expect(result.done).toBe(true)
      expect(result.toolCalls).toEqual([])
      expect(result.usage.promptTokens).toBe(100)
      expect(result.usage.completionTokens).toBe(50)
      expect(result.usage.totalTokens).toBe(150)
      expect(result.usage.totalDurationMs).toBe(5000)
    })
  })

  describe('chat with tool calls', () => {
    it('generates IDs for tool calls when Ollama omits them', async () => {
      const responseWithTools = makeOllamaResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'read_file',
                arguments: {path: '/tmp/test.txt'},
              },
            },
            {
              function: {
                name: 'write_file',
                arguments: {path: '/tmp/out.txt', content: 'hello'},
              },
            },
          ],
        },
      })

      mockFetch(() => jsonResponse(responseWithTools))

      const client = createOllamaClient(defaultConfig)
      const result = await client.chat([{role: 'user', content: 'Read the file'}])

      expect(result.toolCalls).toHaveLength(2)

      // Verify IDs are generated with tc_ prefix
      expect(result.toolCalls[0].id).toMatch(/^tc_[a-f0-9]{8}$/)
      expect(result.toolCalls[1].id).toMatch(/^tc_[a-f0-9]{8}$/)

      // Verify IDs are unique
      expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id)

      // Verify tool call data
      expect(result.toolCalls[0].name).toBe('read_file')
      expect(result.toolCalls[0].arguments).toEqual({path: '/tmp/test.txt'})
      expect(result.toolCalls[1].name).toBe('write_file')
      expect(result.toolCalls[1].arguments).toEqual({path: '/tmp/out.txt', content: 'hello'})
    })

    it('preserves existing IDs if Ollama provides them', async () => {
      const responseWithIds = makeOllamaResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'existing-id-123',
              function: {
                name: 'read_file',
                arguments: {path: '/tmp/test.txt'},
              },
            },
          ],
        },
      })

      mockFetch(() => jsonResponse(responseWithIds))

      const client = createOllamaClient(defaultConfig)
      const result = await client.chat([{role: 'user', content: 'Read the file'}])

      expect(result.toolCalls[0].id).toBe('existing-id-123')
    })
  })

  describe('connection refused', () => {
    it('throws OllamaError with actionable message', async () => {
      mockFetch(() => {
        throw new TypeError('fetch failed: ECONNREFUSED')
      })

      const client = createOllamaClient(defaultConfig)

      try {
        await client.chat([{role: 'user', content: 'Hello'}])
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaError)
        const ollamaErr = err as OllamaError
        expect(ollamaErr.code).toBe('connection_failed')
        expect(ollamaErr.message).toContain('Cannot connect to Ollama')
        expect(ollamaErr.message).toContain('ollama serve')
        expect(ollamaErr.message).toContain('OLLAMA_BASE_URL')
      }
    })

    it('handles generic fetch failures', async () => {
      mockFetch(() => {
        throw new Error('network timeout')
      })

      const client = createOllamaClient(defaultConfig)

      try {
        await client.chat([{role: 'user', content: 'Hello'}])
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaError)
        const ollamaErr = err as OllamaError
        expect(ollamaErr.code).toBe('connection_failed')
        expect(ollamaErr.message).toContain('network timeout')
      }
    })
  })

  describe('model not found', () => {
    it('throws OllamaError with pull instructions on 404', async () => {
      mockFetch(() => textResponse('model "qwen2.5:14b" not found', 404))

      const client = createOllamaClient(defaultConfig)

      try {
        await client.chat([{role: 'user', content: 'Hello'}])
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaError)
        const ollamaErr = err as OllamaError
        expect(ollamaErr.code).toBe('model_not_found')
        expect(ollamaErr.message).toContain('ollama pull qwen2.5:14b')
        expect(ollamaErr.message).toContain('OLLAMA_MODEL')
      }
    })

    it('detects "not found" in response body even on non-404 status', async () => {
      mockFetch(() => textResponse('model not found, try pulling it first', 400))

      const client = createOllamaClient(defaultConfig)

      try {
        await client.chat([{role: 'user', content: 'Hello'}])
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaError)
        const ollamaErr = err as OllamaError
        expect(ollamaErr.code).toBe('model_not_found')
      }
    })
  })

  describe('invalid JSON response', () => {
    it('throws OllamaError with invalid_response code', async () => {
      mockFetch(
        () =>
          new Response('this is not json', {
            status: 200,
            headers: {'Content-Type': 'text/plain'},
          }),
      )

      const client = createOllamaClient(defaultConfig)

      try {
        await client.chat([{role: 'user', content: 'Hello'}])
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaError)
        const ollamaErr = err as OllamaError
        expect(ollamaErr.code).toBe('invalid_response')
        expect(ollamaErr.message).toContain('Invalid JSON')
      }
    })
  })

  describe('request failed', () => {
    it('throws OllamaError with status code on 500', async () => {
      mockFetch(() => textResponse('internal server error', 500))

      const client = createOllamaClient(defaultConfig)

      try {
        await client.chat([{role: 'user', content: 'Hello'}])
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(OllamaError)
        const ollamaErr = err as OllamaError
        expect(ollamaErr.code).toBe('request_failed')
        expect(ollamaErr.message).toContain('500')
        expect(ollamaErr.message).toContain('internal server error')
      }
    })
  })

  describe('usage tracking', () => {
    it('extracts prompt_eval_count and eval_count', async () => {
      mockFetch(() =>
        jsonResponse(
          makeOllamaResponse({
            prompt_eval_count: 250,
            eval_count: 120,
            total_duration: 8_500_000_000, // 8.5 seconds
          }),
        ),
      )

      const client = createOllamaClient(defaultConfig)
      const result = await client.chat([{role: 'user', content: 'Hello'}])

      expect(result.usage.promptTokens).toBe(250)
      expect(result.usage.completionTokens).toBe(120)
      expect(result.usage.totalTokens).toBe(370)
      expect(result.usage.totalDurationMs).toBe(8500)
    })

    it('defaults to 0 when usage fields are missing', async () => {
      mockFetch(() =>
        jsonResponse({
          model: 'qwen2.5:14b',
          message: {role: 'assistant', content: 'Hi'},
          done: true,
          // No usage fields
        }),
      )

      const client = createOllamaClient(defaultConfig)
      const result = await client.chat([{role: 'user', content: 'Hello'}])

      expect(result.usage.promptTokens).toBe(0)
      expect(result.usage.completionTokens).toBe(0)
      expect(result.usage.totalTokens).toBe(0)
      expect(result.usage.totalDurationMs).toBe(0)
    })
  })

  describe('URL normalization', () => {
    it('strips trailing slashes from base URL', async () => {
      let capturedUrl = ''
      mockFetch((url) => {
        capturedUrl = url as string
        return jsonResponse(makeOllamaResponse())
      })

      const client = createOllamaClient({
        ...defaultConfig,
        ollamaBaseUrl: 'http://localhost:11434///',
      })
      await client.chat([{role: 'user', content: 'Hello'}])

      expect(capturedUrl).toBe('http://localhost:11434/api/chat')
    })
  })

  describe('tools in request body', () => {
    it('includes tools when provided', async () => {
      let capturedBody: Record<string, unknown> = {}
      mockFetch((_url, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse(makeOllamaResponse())
      })

      const tools: OllamaTool[] = [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {
                path: {type: 'string'},
              },
              required: ['path'],
            },
          },
        },
      ]

      const client = createOllamaClient(defaultConfig)
      await client.chat([{role: 'user', content: 'Read a file'}], tools)

      expect(capturedBody.tools).toEqual(tools)
      expect(capturedBody.model).toBe('qwen2.5:14b')
      expect(capturedBody.stream).toBe(false)
    })

    it('omits tools from request when array is empty', async () => {
      let capturedBody: Record<string, unknown> = {}
      mockFetch((_url, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse(makeOllamaResponse())
      })

      const client = createOllamaClient(defaultConfig)
      await client.chat([{role: 'user', content: 'Hello'}], [])

      expect(capturedBody.tools).toBeUndefined()
    })

    it('omits tools from request when not provided', async () => {
      let capturedBody: Record<string, unknown> = {}
      mockFetch((_url, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse(makeOllamaResponse())
      })

      const client = createOllamaClient(defaultConfig)
      await client.chat([{role: 'user', content: 'Hello'}])

      expect(capturedBody.tools).toBeUndefined()
    })
  })

  describe('request body structure', () => {
    it('sends correct options (num_ctx, temperature)', async () => {
      let capturedBody: Record<string, unknown> = {}
      mockFetch((_url, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse(makeOllamaResponse())
      })

      const client = createOllamaClient({
        ollamaBaseUrl: 'http://localhost:11434',
        model: 'llama3.1:8b',
        contextWindow: 16384,
        temperature: 0.3,
      })
      await client.chat([{role: 'user', content: 'Hello'}])

      expect(capturedBody.model).toBe('llama3.1:8b')
      expect(capturedBody.stream).toBe(false)
      expect((capturedBody.options as Record<string, unknown>).num_ctx).toBe(16384)
      expect((capturedBody.options as Record<string, unknown>).temperature).toBe(0.3)
    })
  })
})

describe('buildToolResultMessage', () => {
  it('creates tool message with tool_name for string result', () => {
    const msg = buildToolResultMessage('read_file', 'file contents here')

    expect(msg.role).toBe('tool')
    expect(msg.content).toBe('file contents here')
    // Verify tool_name is set (spread pattern adds it at runtime)
    expect((msg as Record<string, unknown>).tool_name).toBe('read_file')
  })

  it('JSON-serializes object results', () => {
    const result = {files: ['a.ts', 'b.ts'], count: 2}
    const msg = buildToolResultMessage('list_files', result)

    expect(msg.role).toBe('tool')
    expect(msg.content).toBe(JSON.stringify(result))
    expect((msg as Record<string, unknown>).tool_name).toBe('list_files')
  })

  it('JSON-serializes array results', () => {
    const result = [1, 2, 3]
    const msg = buildToolResultMessage('get_numbers', result)

    expect(msg.content).toBe('[1,2,3]')
    expect((msg as Record<string, unknown>).tool_name).toBe('get_numbers')
  })

  it('JSON-serializes null result', () => {
    const msg = buildToolResultMessage('void_tool', null)

    expect(msg.content).toBe('null')
    expect((msg as Record<string, unknown>).tool_name).toBe('void_tool')
  })

  it('JSON-serializes number result', () => {
    const msg = buildToolResultMessage('count_tool', 42)

    expect(msg.content).toBe('42')
  })

  it('JSON-serializes boolean result', () => {
    const msg = buildToolResultMessage('check_tool', true)

    expect(msg.content).toBe('true')
  })
})

describe('OllamaError', () => {
  it('has correct name and code', () => {
    const err = new OllamaError('test error', 'connection_failed')
    expect(err.name).toBe('OllamaError')
    expect(err.code).toBe('connection_failed')
    expect(err.message).toBe('test error')
    expect(err).toBeInstanceOf(Error)
  })

  it('preserves cause', () => {
    const cause = new Error('original')
    const err = new OllamaError('wrapped', 'request_failed', cause)
    expect(err.cause).toBe(cause)
  })
})
