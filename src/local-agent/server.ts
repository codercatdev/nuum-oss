/**
 * HTTP server for the local agent runner.
 *
 * Accepts Chorus payloads from miriad-redux and invokes the agent runner.
 * This is the entry point that replaces Singular's connectionString endpoint.
 *
 * Endpoints:
 * - POST /agent — Accept ChorusPayload, validate, invoke runner (fire-and-forget)
 * - GET /health — Health check
 */

import type {RunnerConfig} from './types'
import {DEFAULT_RUNNER_CONFIG, validateChorusPayload} from './types'
import {runLocalAgent} from './runner'

/**
 * Maximum request body size (1MB).
 * Prevents memory exhaustion from oversized payloads.
 */
const MAX_BODY_SIZE = 1024 * 1024

/**
 * Server instance handle returned by startServer.
 */
export interface ServerHandle {
  /** The underlying Bun server */
  server: ReturnType<typeof Bun.serve>
  /** The port the server is listening on */
  port: number
  /** Stop the server */
  stop(): void
}

/**
 * Start the local agent HTTP server.
 *
 * @param config - Runner configuration (uses config.port for listen port)
 * @returns ServerHandle with stop() method
 */
export function startServer(config: RunnerConfig = DEFAULT_RUNNER_CONFIG): ServerHandle {
  const server = Bun.serve({
    port: config.port,
    fetch: createRequestHandler(config),
  })

  console.log(`[local-agent] Server listening on http://localhost:${server.port}`)
  console.log(`[local-agent] POST /agent — accept Chorus payloads`)
  console.log(`[local-agent] GET  /health — health check`)
  console.log(`[local-agent] Model: ${config.model} @ ${config.ollamaBaseUrl}`)

  return {
    server,
    port: server.port,
    stop() {
      server.stop()
      console.log('[local-agent] Server stopped')
    },
  }
}

/**
 * Create the request handler function.
 * Separated from startServer for testability.
 */
export function createRequestHandler(config: RunnerConfig) {
  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        model: config.model,
        ollamaBaseUrl: config.ollamaBaseUrl,
        port: config.port,
      })
    }

    // Agent endpoint
    if (req.method === 'POST' && url.pathname === '/agent') {
      return handleAgentRequest(req, config)
    }

    // 404 for everything else
    return Response.json(
      {
        error: 'Not found',
        hint: 'POST /agent to invoke the agent, GET /health for status',
      },
      {status: 404},
    )
  }
}

/**
 * Handle POST /agent — validate payload and invoke runner.
 */
async function handleAgentRequest(req: Request, config: RunnerConfig): Promise<Response> {
  // Check content-type
  const contentType = req.headers.get('content-type')
  if (!contentType?.includes('application/json')) {
    return Response.json(
      {error: 'Content-Type must be application/json'},
      {status: 415},
    )
  }

  // Check body size
  const contentLength = req.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return Response.json(
      {error: `Request body too large (max ${MAX_BODY_SIZE} bytes)`},
      {status: 413},
    )
  }

  // Parse JSON body
  let body: unknown
  try {
    const text = await req.text()
    if (text.length > MAX_BODY_SIZE) {
      return Response.json(
        {error: `Request body too large (max ${MAX_BODY_SIZE} bytes)`},
        {status: 413},
      )
    }
    body = JSON.parse(text)
  } catch {
    return Response.json(
      {error: 'Invalid JSON in request body'},
      {status: 400},
    )
  }

  // Validate payload
  const errors = validateChorusPayload(body)
  if (errors.length > 0) {
    return Response.json(
      {error: 'Invalid ChorusPayload', details: errors},
      {status: 400},
    )
  }

  // Fire-and-forget: invoke runner asynchronously
  // Return 200 immediately — the runner posts results via callbacks
  const payload = body as import('./types').ChorusPayload
  runLocalAgent(payload, config)
    .then((result) => {
      if (result.success) {
        console.log(
          `[local-agent] Run complete: ${result.iterations} iterations, ` +
            `${result.usage.totalTokens} tokens` +
            (result.warnings.length > 0 ? `, ${result.warnings.length} warnings` : ''),
        )
      } else {
        console.error(`[local-agent] Run failed: ${result.error}`)
      }
    })
    .catch((err) => {
      // This should never happen since runLocalAgent never throws,
      // but just in case
      console.error('[local-agent] Unexpected runner error:', err)
    })

  return Response.json({
    status: 'accepted',
    message: `Agent invoked for channel ${payload.channel.name}`,
  })
}
