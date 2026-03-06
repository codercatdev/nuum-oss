#!/usr/bin/env node
/**
 * nuum CLI entry point
 *
 * Phase 1 deliverable: `nuum -p "prompt" --verbose`
 * Phase 2.1: `nuum --inspect` and `nuum --dump`
 * Phase 3a: `nuum --stdio` for JSON-RPC mode
 */

import {parseArgs} from 'util'
import {runBatch} from './batch'
import {runInspect, runDump, runCompact} from './inspect'
import {runServer} from '../jsonrpc'
import {runRepl} from './repl'
import {VERSION_STRING} from '../version'
import {Log} from '../util/log'
import {printError, printSimpleError} from './error'
import {renderRaw} from './renderer'
import {startServer} from '../local-agent/server'
import {DEFAULT_RUNNER_CONFIG} from '../local-agent/types'

interface CliOptions {
  prompt: string | undefined
  verbose: boolean
  db: string
  format: 'text' | 'json'
  help: boolean
  version: boolean
  inspect: boolean
  dump: boolean
  compact: boolean
  stdio: boolean
  repl: boolean
  serve: boolean
  port: number
}

function parseCliArgs(): CliOptions {
  const {values} = parseArgs({
    options: {
      prompt: {type: 'string', short: 'p'},
      verbose: {type: 'boolean', short: 'v', default: false},
      db: {type: 'string', default: './agent.db'},
      format: {type: 'string', default: 'text'},
      help: {type: 'boolean', short: 'h', default: false},
      version: {type: 'boolean', short: 'V', default: false},
      inspect: {type: 'boolean', default: false},
      dump: {type: 'boolean', default: false},
      compact: {type: 'boolean', default: false},
      stdio: {type: 'boolean', default: false},
      repl: {type: 'boolean', default: false},
      serve: {type: 'boolean', default: false},
      port: {type: 'string', default: '3001'},
    },
    allowPositionals: false,
  })

  return {
    prompt: values.prompt,
    verbose: values.verbose ?? false,
    db: values.db ?? './agent.db',
    format: (values.format as 'text' | 'json') ?? 'text',
    help: values.help ?? false,
    version: values.version ?? false,
    inspect: values.inspect ?? false,
    dump: values.dump ?? false,
    compact: values.compact ?? false,
    stdio: values.stdio ?? false,
    repl: values.repl ?? false,
    serve: values.serve ?? false,
    port: parseInt(values.port as string ?? '3001', 10),
  }
}

function printHelp(): void {
  console.log(`
${VERSION_STRING}

A coding agent with persistent memory

Usage:
  nuum -p "prompt"           Run agent with a prompt
  nuum -p "prompt" --verbose Show debug output
  nuum --repl                Start interactive REPL mode
  nuum --stdio               Start protocol server over stdin/stdout
  nuum --serve               Start local agent HTTP server (Chorus-compatible)
  nuum --inspect             Show memory stats (no LLM call)
  nuum --dump                Show raw system prompt (no LLM call)
  nuum --compact             Force run compaction (distillation)
  nuum --help                Show this help

Options:
  -p, --prompt <text>   The prompt to send to the agent
  -v, --verbose         Show memory state, token usage, and execution trace
      --repl            Start interactive REPL with readline support
      --stdio           Start Claude Code SDK protocol server on stdin/stdout
      --serve           Start local agent HTTP server for miriad-redux
      --port <number>   Port for --serve (default: 3001)
      --inspect         Show memory statistics: temporal, present, LTM
      --dump            Dump the full system prompt that would be sent to LLM
      --compact         Force run compaction to reduce effective view size
      --db <path>       SQLite database path (default: ./agent.db)
      --format <type>   Output format: text or json (default: text)
  -h, --help            Show this help message
  -V, --version         Show version information

REPL Mode (--repl):
  Interactive mode with readline, history, and streaming output.

  Commands:
    /help    Show available commands
    /quit    Exit the REPL
    /clear   Clear conversation (fresh session)
    /inspect Show memory statistics
    /dump    Show full system prompt

  Shortcuts: Ctrl+C (cancel), Ctrl+D (exit), Up/Down (history)

JSON-RPC Mode (--stdio):
  Accepts NDJSON requests on stdin, streams responses on stdout.

  Request: {"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"..."}}
  Response: {"jsonrpc":"2.0","id":1,"result":{"type":"text","chunk":"..."}}
           {"jsonrpc":"2.0","id":1,"result":{"type":"complete","response":"..."}}

  Methods: run, cancel, status

Environment:
  AGENT_PROVIDER          Provider: 'anthropic' (default) or 'ollama'
  ANTHROPIC_API_KEY       Required for Anthropic provider.
  OLLAMA_BASE_URL         Ollama server URL (default: http://localhost:11434)
  BRAVE_SEARCH_API_KEY    Optional. Enables Brave Search (recommended).
                          Without it, web search falls back to DuckDuckGo.
                          Free key: https://brave.com/search/api/

Examples:
  nuum -p "What files are in src/"
  nuum -p "Refactor the auth module" --verbose
  nuum --repl
  nuum --repl --db ./project.db
  nuum -p "List todos" --format=json
  nuum --inspect --db ./my-agent.db
  nuum --dump
  nuum --stdio --db ./agent.db
  nuum --serve               Start local agent server on port 3001
  nuum --serve --port 8080   Start on custom port
`)
}

async function main(): Promise<void> {
  const options = parseCliArgs()

  // Enable verbose logging only when --verbose is passed
  if (options.verbose) {
    Log.setLevel('DEBUG')
  }

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  if (options.version) {
    renderRaw(VERSION_STRING + '\n')
    process.exit(0)
  }

  // Handle --repl (interactive mode)
  if (options.repl) {
    try {
      await runRepl({dbPath: options.db})
      // runRepl keeps running until user quits
    } catch (error) {
      printError(error, {verbose: options.verbose})
      process.exit(1)
    }
    return
  }

  // Handle --serve (local agent HTTP server)
  if (options.serve) {
    try {
      const config = {
        ...DEFAULT_RUNNER_CONFIG,
        port: options.port,
      }
      const handle = startServer(config)
      // Keep process alive until interrupted
      process.on('SIGINT', () => {
        handle.stop()
        process.exit(0)
      })
      process.on('SIGTERM', () => {
        handle.stop()
        process.exit(0)
      })
      // Block forever (server runs in background)
      await new Promise(() => {})
    } catch (error) {
      printError(error, {verbose: options.verbose})
      process.exit(1)
    }
    return
  }

  // Handle --stdio (JSON-RPC mode)
  if (options.stdio) {
    try {
      await runServer({dbPath: options.db})
      // runServer keeps running until stdin closes
    } catch (error) {
      printError(error, {verbose: options.verbose})
      process.exit(1)
    }
    return
  }

  // Handle --inspect (no LLM call)
  if (options.inspect) {
    try {
      await runInspect(options.db)
      process.exit(0)
    } catch (error) {
      printError(error, {verbose: options.verbose})
      process.exit(1)
    }
  }

  // Handle --dump (no LLM call)
  if (options.dump) {
    try {
      await runDump(options.db)
      process.exit(0)
    } catch (error) {
      printError(error, {verbose: options.verbose})
      process.exit(1)
    }
  }

  // Handle --compact (force compaction)
  if (options.compact) {
    try {
      await runCompact(options.db)
      process.exit(0)
    } catch (error) {
      printError(error, {verbose: options.verbose})
      process.exit(1)
    }
  }

  // Regular prompt mode requires --prompt
  if (!options.prompt) {
    printSimpleError(
      '--prompt (-p) is required (or use --repl/--stdio/--inspect/--dump)',
      'Run with --help for usage information',
    )
    process.exit(1)
  }

  try {
    await runBatch({
      prompt: options.prompt,
      verbose: options.verbose,
      dbPath: options.db,
      format: options.format,
    })
  } catch (error) {
    printError(error, {verbose: options.verbose})
    process.exit(1)
  }
}

main()
