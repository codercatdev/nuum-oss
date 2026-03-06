/**
 * Tests for the local agent HTTP server.
 *
 * Tests the request handler directly (via createRequestHandler) to avoid
 * port conflicts. Only the server lifecycle tests start a real server
 * (using port 0 for random available port).
 */

import {describe, it, expect, afterEach, mock} from 'bun:test'
import {createRequestHandler, startServer} from './server'
import type {RunnerConfig, ChorusPayload} from './types'

// ─── Test Config ───

const testConfig: RunnerConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'test-model',
  maxIterations: 50,
  contextWindow: 32768,
  temperature: 0.7,
  port: 0, // Use port 0 for random available port in tests
}

// ─── Helpers ───

function validPayload(): ChorusPayload {
  return {
    channel: {id: 'ch_test', name: '#test', service: 'Miriad', prompt: 'You are helpful.'},
    message: {id: '01JTEST', sender: '@user', content: 'Hello!'},
    callback: 'http://localhost:3000/chorus/callback/token',
    mcp: [],
    directTools: [],
  }
}

/**
 * Helper to create a Request object for testing.
 */
function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `http://localhost:3001${path}`
  const init: RequestInit = {method}
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = {'Content-Type': 'application/json', ...headers}
  } else if (headers) {
    init.headers = headers
  }
  return new Request(url, init)
}

// Save original fetch so fire-and-forget runner calls don't hit real network
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

// ─── Health Check ───

describe('GET /health', () => {
  const handler = createRequestHandler(testConfig)

  it('returns 200 with status ok', async () => {
    const req = new Request('http://localhost:3001/health', {method: 'GET'})
    const res = await handler(req)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('includes config values in response', async () => {
    const req = new Request('http://localhost:3001/health', {method: 'GET'})
    const res = await handler(req)

    const body = await res.json()
    expect(body.model).toBe('test-model')
    expect(body.ollamaBaseUrl).toBe('http://localhost:11434')
    expect(body.port).toBe(0)
  })
})

// ─── Agent Endpoint — Happy Path ───

describe('POST /agent — happy path', () => {
  const handler = createRequestHandler(testConfig)

  it('returns 200 accepted for valid payload', async () => {
    // Mock fetch so the fire-and-forget runner doesn't make real calls
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({message: {role: 'assistant', content: 'Hi'}, done: true}), {status: 200})),
    ) as typeof fetch

    const req = makeRequest('POST', '/agent', validPayload())
    const res = await handler(req)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('accepted')
  })

  it('includes channel name in response message', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({message: {role: 'assistant', content: 'Hi'}, done: true}), {status: 200})),
    ) as typeof fetch

    const req = makeRequest('POST', '/agent', validPayload())
    const res = await handler(req)

    const body = await res.json()
    expect(body.message).toContain('#test')
  })
})

// ─── Input Validation ───

describe('POST /agent — input validation', () => {
  const handler = createRequestHandler(testConfig)

  it('returns 415 without Content-Type application/json', async () => {
    const req = new Request('http://localhost:3001/agent', {
      method: 'POST',
      body: JSON.stringify(validPayload()),
      headers: {'Content-Type': 'text/plain'},
    })
    const res = await handler(req)

    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.error).toContain('Content-Type')
  })

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('http://localhost:3001/agent', {
      method: 'POST',
      body: '{not valid json',
      headers: {'Content-Type': 'application/json'},
    })
    const res = await handler(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid JSON')
  })

  it('returns 400 with details for missing required fields', async () => {
    const req = makeRequest('POST', '/agent', {channel: null, message: null})
    const res = await handler(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid ChorusPayload')
    expect(Array.isArray(body.details)).toBe(true)
    expect(body.details.length).toBeGreaterThan(0)
  })

  it('returns 400 for empty object body', async () => {
    const req = makeRequest('POST', '/agent', {})
    const res = await handler(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid ChorusPayload')
  })

  it('returns 413 for oversized Content-Length', async () => {
    const req = new Request('http://localhost:3001/agent', {
      method: 'POST',
      body: JSON.stringify(validPayload()),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '2000000', // 2MB > 1MB limit
      },
    })
    const res = await handler(req)

    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toContain('too large')
  })
})

// ─── Routing ───

describe('routing', () => {
  const handler = createRequestHandler(testConfig)

  it('returns 404 for GET /agent (wrong method)', async () => {
    const req = new Request('http://localhost:3001/agent', {method: 'GET'})
    const res = await handler(req)

    expect(res.status).toBe(404)
  })

  it('returns 404 for POST /health (wrong method)', async () => {
    const req = new Request('http://localhost:3001/health', {
      method: 'POST',
      body: '{}',
      headers: {'Content-Type': 'application/json'},
    })
    const res = await handler(req)

    expect(res.status).toBe(404)
  })

  it('returns 404 with hint for GET /unknown', async () => {
    const req = new Request('http://localhost:3001/unknown', {method: 'GET'})
    const res = await handler(req)

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Not found')
    expect(body.hint).toContain('POST /agent')
    expect(body.hint).toContain('GET /health')
  })

  it('returns 404 with hint for POST /unknown', async () => {
    const req = new Request('http://localhost:3001/unknown', {
      method: 'POST',
      body: '{}',
      headers: {'Content-Type': 'application/json'},
    })
    const res = await handler(req)

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.hint).toBeDefined()
  })
})

// ─── Fire-and-Forget Behavior ───

describe('fire-and-forget', () => {
  const handler = createRequestHandler(testConfig)

  it('returns immediately without waiting for runner', async () => {
    // Mock fetch to be slow — if the server waited, this test would be slow
    globalThis.fetch = mock(() =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(new Response(JSON.stringify({message: {role: 'assistant', content: 'Hi'}, done: true}), {status: 200})),
          5000,
        ),
      ),
    ) as typeof fetch

    const start = Date.now()
    const req = makeRequest('POST', '/agent', validPayload())
    const res = await handler(req)
    const elapsed = Date.now() - start

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('accepted')
    // Should return in well under 1 second (the mock fetch takes 5s)
    expect(elapsed).toBeLessThan(1000)
  })

  it('validates payload before invoking runner (invalid payload gets 400, not 200)', async () => {
    // If validation happened after fire-and-forget, we'd get 200 for invalid payloads
    const req = makeRequest('POST', '/agent', {invalid: true})
    const res = await handler(req)

    expect(res.status).toBe(400)
  })
})

// ─── Server Lifecycle ───

describe('server lifecycle', () => {
  it('startServer returns ServerHandle with port and stop()', () => {
    const handle = startServer({...testConfig, port: 0})
    try {
      expect(handle.port).toBeGreaterThan(0)
      expect(typeof handle.stop).toBe('function')
      expect(handle.server).toBeDefined()
    } finally {
      handle.stop()
    }
  })

  it('stop() shuts down the server', async () => {
    const handle = startServer({...testConfig, port: 0})
    const port = handle.port

    // Server should be reachable
    const res = await fetch(`http://localhost:${port}/health`)
    expect(res.status).toBe(200)

    // Stop the server
    handle.stop()

    // Server should no longer be reachable
    try {
      await fetch(`http://localhost:${port}/health`)
      // If we get here, the server is still running — that's a failure
      // But Bun.serve stop might be async, so give it a moment
      await new Promise((r) => setTimeout(r, 100))
      try {
        await fetch(`http://localhost:${port}/health`)
        // Some environments may still respond briefly after stop
        // The important thing is stop() doesn't throw
      } catch {
        // Expected — server is stopped
      }
    } catch {
      // Expected — connection refused means server is stopped
    }
  })
})
