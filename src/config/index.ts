/**
 * Configuration for nuum
 *
 * Supports multiple providers:
 * - 'anthropic' (default): Requires ANTHROPIC_API_KEY
 * - 'ollama': Requires Ollama running (default: localhost:11434)
 *
 * Provider is selected via AGENT_PROVIDER env var.
 */

import {z} from 'zod'

export namespace Config {
  /**
   * Model tiers for different use cases.
   * See arch spec for token budget rationale.
   */
  export type ModelTier = 'reasoning' | 'workhorse' | 'fast'

  /**
   * Supported provider identifiers.
   */
  export const SUPPORTED_PROVIDERS = ['anthropic', 'ollama'] as const
  export type ProviderType = (typeof SUPPORTED_PROVIDERS)[number]

  /**
   * Default models per provider.
   */
  const PROVIDER_MODEL_DEFAULTS: Record<ProviderType, Record<ModelTier, string>> = {
    anthropic: {
      reasoning: 'claude-opus-4-6',
      workhorse: 'claude-sonnet-4-5-20250929',
      fast: 'claude-haiku-4-5-20251001',
    },
    ollama: {
      reasoning: 'qwen2.5:32b',
      workhorse: 'qwen2.5:14b',
      fast: 'qwen2.5:7b',
    },
  }

  /**
   * Default token budgets per provider.
   *
   * Anthropic models support 200K-1M context windows.
   * Ollama models work best at 28K-32K (even if they technically support more).
   */
  const PROVIDER_TOKEN_DEFAULTS: Record<ProviderType, {
    fixedOverheadTokens: number
    mainAgentContext: number
    temporalBudget: number
    compactionThreshold: number
    compactionTarget: number
    compactionHardLimit: number
    recencyBufferMessages: number
    temporalQueryBudget: number
    ltmReflectBudget: number
    ltmConsolidateBudget: number
  }> = {
    anthropic: {
      fixedOverheadTokens: 40_000,
      mainAgentContext: 180_000,
      temporalBudget: 64_000,
      compactionThreshold: 80_000,
      compactionTarget: 60_000,
      compactionHardLimit: 150_000,
      recencyBufferMessages: 10,
      temporalQueryBudget: 512_000,
      ltmReflectBudget: 180_000,
      ltmConsolidateBudget: 512_000,
    },
    ollama: {
      fixedOverheadTokens: 4_000,
      mainAgentContext: 28_000,
      temporalBudget: 12_000,
      compactionThreshold: 16_000,
      compactionTarget: 12_000,
      compactionHardLimit: 24_000,
      recencyBufferMessages: 6,
      temporalQueryBudget: 28_000,
      ltmReflectBudget: 28_000,
      ltmConsolidateBudget: 28_000,
    },
  }

  /**
   * Validate and normalize the provider string.
   * Throws with an actionable error for unknown providers.
   */
  function validateProvider(provider: string): ProviderType {
    if (SUPPORTED_PROVIDERS.includes(provider as ProviderType)) {
      return provider as ProviderType
    }
    throw new Error(
      `Unknown AGENT_PROVIDER: "${provider}". ` +
        `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}. ` +
        `Set AGENT_PROVIDER=ollama for local Ollama, or omit for Anthropic (default).`,
    )
  }

  /**
   * Get the default models for a provider.
   */
  function getModelDefaults(provider: ProviderType): Record<ModelTier, string> {
    return PROVIDER_MODEL_DEFAULTS[provider]
  }

  /**
   * Get the default token budgets for a provider.
   */
  function getTokenDefaults(provider: ProviderType) {
    return PROVIDER_TOKEN_DEFAULTS[provider]
  }

  export const Schema = z.object({
    provider: z.string().default('anthropic'),
    ollamaBaseUrl: z.string().default('http://localhost:11434/v1'),
    models: z.object({
      /** Main agent, LTM reflection - best judgment */
      reasoning: z.string().optional(),
      /** Memory management, search - high context */
      workhorse: z.string().optional(),
      /** Quick classifications - fast response */
      fast: z.string().optional(),
    }),
    db: z.string().default('./agent.db'),
    tokenBudgets: z.object({
      /** Fixed overhead for system prompt, tools, formatting */
      fixedOverheadTokens: z.number().optional(),
      /** Main agent context limit */
      mainAgentContext: z.number().optional(),
      /** Max tokens for temporal view in prompt */
      temporalBudget: z.number().optional(),
      /** Soft limit: run compaction synchronously before turn if exceeded */
      compactionThreshold: z.number().optional(),
      /** Target size after compaction */
      compactionTarget: z.number().optional(),
      /** Hard limit: refuse turn entirely if exceeded (emergency brake) */
      compactionHardLimit: z.number().optional(),
      /** Minimum recent messages to preserve (never summarized) */
      recencyBufferMessages: z.number().optional(),
      /** Temporal search sub-agent budget */
      temporalQueryBudget: z.number().optional(),
      /** LTM reflection sub-agent budget */
      ltmReflectBudget: z.number().optional(),
      /** LTM consolidation worker budget */
      ltmConsolidateBudget: z.number().optional(),
    }),
  })

  /**
   * Resolved config with all defaults applied based on provider.
   */
  export interface Config {
    provider: ProviderType
    ollamaBaseUrl: string
    models: Record<ModelTier, string>
    db: string
    tokenBudgets: {
      fixedOverheadTokens: number
      mainAgentContext: number
      temporalBudget: number
      compactionThreshold: number
      compactionTarget: number
      compactionHardLimit: number
      recencyBufferMessages: number
      temporalQueryBudget: number
      ltmReflectBudget: number
      ltmConsolidateBudget: number
    }
  }

  let cached: Config | null = null

  /**
   * Get the current configuration.
   * Loads from environment variables with provider-aware defaults.
   * Throws on invalid provider or broken token budget invariants.
   */
  export function get(): Config {
    if (cached) return cached

    const raw = Schema.parse({
      provider: process.env.AGENT_PROVIDER,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
      models: {
        reasoning: process.env.AGENT_MODEL_REASONING,
        workhorse: process.env.AGENT_MODEL_WORKHORSE,
        fast: process.env.AGENT_MODEL_FAST,
      },
      db: process.env.AGENT_DB,
      tokenBudgets: {},
    })

    // Validate provider — throws with actionable error for unknown values
    const provider = validateProvider(raw.provider)

    // Resolve defaults based on provider
    const modelDefaults = getModelDefaults(provider)
    const tokenDefaults = getTokenDefaults(provider)

    const resolvedBudgets = {
      fixedOverheadTokens: raw.tokenBudgets.fixedOverheadTokens ?? tokenDefaults.fixedOverheadTokens,
      mainAgentContext: raw.tokenBudgets.mainAgentContext ?? tokenDefaults.mainAgentContext,
      temporalBudget: raw.tokenBudgets.temporalBudget ?? tokenDefaults.temporalBudget,
      compactionThreshold: raw.tokenBudgets.compactionThreshold ?? tokenDefaults.compactionThreshold,
      compactionTarget: raw.tokenBudgets.compactionTarget ?? tokenDefaults.compactionTarget,
      compactionHardLimit: raw.tokenBudgets.compactionHardLimit ?? tokenDefaults.compactionHardLimit,
      recencyBufferMessages: raw.tokenBudgets.recencyBufferMessages ?? tokenDefaults.recencyBufferMessages,
      temporalQueryBudget: raw.tokenBudgets.temporalQueryBudget ?? tokenDefaults.temporalQueryBudget,
      ltmReflectBudget: raw.tokenBudgets.ltmReflectBudget ?? tokenDefaults.ltmReflectBudget,
      ltmConsolidateBudget: raw.tokenBudgets.ltmConsolidateBudget ?? tokenDefaults.ltmConsolidateBudget,
    }

    // Validate token budget invariants to prevent infinite compaction loops
    // (Risk #8 from QA risk register)
    if (resolvedBudgets.compactionThreshold <= resolvedBudgets.compactionTarget) {
      throw new Error(
        `Invalid token budget: compactionThreshold (${resolvedBudgets.compactionThreshold}) ` +
          `must be greater than compactionTarget (${resolvedBudgets.compactionTarget}). ` +
          `This would cause an infinite compaction loop.`,
      )
    }
    if (resolvedBudgets.mainAgentContext <= resolvedBudgets.compactionThreshold) {
      throw new Error(
        `Invalid token budget: mainAgentContext (${resolvedBudgets.mainAgentContext}) ` +
          `must be greater than compactionThreshold (${resolvedBudgets.compactionThreshold}). ` +
          `The agent would trigger compaction on every turn.`,
      )
    }
    if (resolvedBudgets.fixedOverheadTokens >= resolvedBudgets.compactionHardLimit) {
      throw new Error(
        `Invalid token budget: fixedOverheadTokens (${resolvedBudgets.fixedOverheadTokens}) ` +
          `must be less than compactionHardLimit (${resolvedBudgets.compactionHardLimit}). ` +
          `The agent would fail the context overflow check on every turn.`,
      )
    }

    cached = {
      provider,
      ollamaBaseUrl: raw.ollamaBaseUrl,
      models: {
        reasoning: raw.models.reasoning ?? modelDefaults.reasoning,
        workhorse: raw.models.workhorse ?? modelDefaults.workhorse,
        fast: raw.models.fast ?? modelDefaults.fast,
      },
      db: raw.db,
      tokenBudgets: resolvedBudgets,
    }

    return cached
  }

  /**
   * Get the model ID for a given tier.
   */
  export function resolveModelTier(tier: ModelTier): string {
    const config = get()
    return config.models[tier]
  }

  /**
   * Reset cached config (for testing).
   */
  export function reset(): void {
    cached = null
  }
}
