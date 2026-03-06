/**
 * Tests for local agent types and validation.
 */

import {describe, it, expect} from 'bun:test'
import {
  validateChorusPayload,
  DEFAULT_RUNNER_CONFIG,
  type ChorusPayload,
  type CallbackEvent,
  type OllamaTool,
  type RunnerConfig,
} from './types'

// ─── Test Fixtures ───

function validPayload(): ChorusPayload {
  return {
    channel: {
      id: 'ch_abc123',
      name: '#test-channel',
      service: 'Miriad',
      prompt: 'You are a helpful assistant.',
    },
    message: {
      id: '01JTEST000000000000000000',
      sender: '@user',
      content: 'Hello, agent!',
    },
    callback: 'http://localhost:3000/chorus/callback/hmac_token_here',
    mcp: [
      {
        name: 'miriad',
        main: true,
        url: 'http://localhost:3000/mcp/ch_abc123',
        headers: {Authorization: 'Agent hmac_token_here'},
      },
    ],
    directTools: [
      {
        name: 'send_message',
        description: 'Send a message to the channel',
        inputSchema: {
          type: 'object',
          properties: {
            content: {type: 'string'},
          },
        },
        callUrl: 'http://localhost:3000/tools/call/ch_abc123',
        headers: {Authorization: 'Agent hmac_token_here'},
      },
    ],
  }
}

// ─── Validation Tests ───

describe('validateChorusPayload', () => {
  it('accepts a valid payload', () => {
    const errors = validateChorusPayload(validPayload())
    expect(errors).toEqual([])
  })

  it('accepts a valid payload without directTools', () => {
    const payload = validPayload()
    delete (payload as any).directTools
    const errors = validateChorusPayload(payload)
    expect(errors).toEqual([])
  })

  it('rejects null', () => {
    const errors = validateChorusPayload(null)
    expect(errors).toEqual(['Payload must be a non-null object'])
  })

  it('rejects non-object', () => {
    const errors = validateChorusPayload('not an object')
    expect(errors).toEqual(['Payload must be a non-null object'])
  })

  it('rejects missing channel', () => {
    const payload = validPayload()
    delete (payload as any).channel
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('Missing or invalid "channel" object')
  })

  it('rejects empty channel.id', () => {
    const payload = validPayload()
    payload.channel.id = ''
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('channel.id must be a non-empty string')
  })

  it('rejects empty channel.name', () => {
    const payload = validPayload()
    payload.channel.name = ''
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('channel.name must be a non-empty string')
  })

  it('rejects missing message', () => {
    const payload = validPayload()
    delete (payload as any).message
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('Missing or invalid "message" object')
  })

  it('rejects empty message.id', () => {
    const payload = validPayload()
    payload.message.id = ''
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('message.id must be a non-empty string')
  })

  it('rejects empty message.sender', () => {
    const payload = validPayload()
    payload.message.sender = ''
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('message.sender must be a non-empty string')
  })

  it('rejects missing callback', () => {
    const payload = validPayload()
    delete (payload as any).callback
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('Missing or invalid "callback" URL string')
  })

  it('rejects invalid callback URL', () => {
    const payload = validPayload()
    payload.callback = 'not-a-url'
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('callback must be a valid URL')
  })

  it('rejects missing mcp array', () => {
    const payload = validPayload()
    delete (payload as any).mcp
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('Missing or invalid "mcp" array')
  })

  it('validates mcp server entries', () => {
    const payload = validPayload()
    payload.mcp = [{name: '', url: '', headers: null} as any]
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('mcp[0].name must be a non-empty string')
    expect(errors).toContain('mcp[0].url must be a non-empty string')
    expect(errors).toContain('mcp[0].headers must be an object')
  })

  it('validates directTools entries when present', () => {
    const payload = validPayload()
    payload.directTools = [{name: '', description: 42, inputSchema: null, callUrl: '', headers: null} as any]
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('directTools[0].name must be a non-empty string')
    expect(errors).toContain('directTools[0].description must be a string')
    expect(errors).toContain('directTools[0].inputSchema must be an object')
    expect(errors).toContain('directTools[0].callUrl must be a non-empty string')
    expect(errors).toContain('directTools[0].headers must be an object')
  })

  it('rejects directTools that is not an array', () => {
    const payload = validPayload()
    ;(payload as any).directTools = 'not-an-array'
    const errors = validateChorusPayload(payload)
    expect(errors).toContain('"directTools" must be an array if present')
  })

  it('collects multiple errors at once', () => {
    const errors = validateChorusPayload({})
    expect(errors.length).toBeGreaterThan(1)
    expect(errors).toContain('Missing or invalid "channel" object')
    expect(errors).toContain('Missing or invalid "message" object')
    expect(errors).toContain('Missing or invalid "callback" URL string')
    expect(errors).toContain('Missing or invalid "mcp" array')
  })

  it('accepts empty mcp array', () => {
    const payload = validPayload()
    payload.mcp = []
    const errors = validateChorusPayload(payload)
    expect(errors).toEqual([])
  })

  it('accepts empty directTools array', () => {
    const payload = validPayload()
    payload.directTools = []
    const errors = validateChorusPayload(payload)
    expect(errors).toEqual([])
  })
})

// ─── Type Shape Tests ───

describe('DEFAULT_RUNNER_CONFIG', () => {
  it('has all required fields', () => {
    expect(DEFAULT_RUNNER_CONFIG.ollamaBaseUrl).toBe('http://localhost:11434')
    expect(DEFAULT_RUNNER_CONFIG.model).toBe('qwen2.5:14b')
    expect(DEFAULT_RUNNER_CONFIG.maxIterations).toBe(50)
    expect(DEFAULT_RUNNER_CONFIG.contextWindow).toBe(32768)
    expect(DEFAULT_RUNNER_CONFIG.temperature).toBe(0.7)
    expect(DEFAULT_RUNNER_CONFIG.port).toBe(3001)
  })
})

// ─── Type Compatibility Tests (compile-time checks) ───

describe('type compatibility', () => {
  it('CallbackEvent union covers all event types', () => {
    // These are compile-time checks — if they typecheck, the union is correct
    const lifecycle: CallbackEvent = {type: 'lifecycle', status: 'processing'}
    const message: CallbackEvent = {type: 'message', content: 'Hello'}
    const toolCall: CallbackEvent = {type: 'tool_call', id: 'tc_1', name: 'read', arguments: {path: '/test'}}
    const toolResult: CallbackEvent = {type: 'tool_result', result: {content: 'file data'}}
    const error: CallbackEvent = {type: 'error', message: 'Something went wrong'}

    expect(lifecycle.type).toBe('lifecycle')
    expect(message.type).toBe('message')
    expect(toolCall.type).toBe('tool_call')
    expect(toolResult.type).toBe('tool_result')
    expect(error.type).toBe('error')
  })

  it('LifecycleEvent supports optional usage', () => {
    const idle: CallbackEvent = {
      type: 'lifecycle',
      status: 'idle',
      usage: {
        byModel: {'qwen2.5:14b': {promptTokens: 100, completionTokens: 50}},
        totalTokens: 150,
      },
    }
    expect(idle.type).toBe('lifecycle')
  })

  it('OllamaTool matches OpenAI function calling format', () => {
    const tool: OllamaTool = {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: {type: 'string'},
          },
          required: ['path'],
        },
      },
    }
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('read')
  })
})
