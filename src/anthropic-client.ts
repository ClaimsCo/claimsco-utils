/**
 * anthropic-client — singleton client for Anthropic API calls with platform integration.
 *
 * Wraps `npm:@anthropic-ai/sdk` with:
 *   - withRetry for transient failure handling
 *   - LLMCache for response caching (deterministic by prompt + model + params)
 *   - LLMUsage for cost/token tracking on every call
 *   - Automatic CDN externalization for responses >15KB (matches audit() pattern)
 *
 * Usage:
 *   import { callAnthropic } from "https://raw.githubusercontent.com/.../anthropic-client.ts";
 *
 *   const result = await callAnthropic(base44, {
 *     model: 'claude-sonnet-4-20250514',
 *     messages: [{ role: 'user', content: 'Classify this email...' }],
 *     functionName: 'analyzeCorrespondence',
 *     useCache: true,
 *     cacheTtlHours: 168,
 *   });
 *
 * Returns: { text, usage: { input_tokens, output_tokens }, cacheHit, model, cachedAt? }
 *
 * Required env: ANTHROPIC_API_KEY (set in Base44 secrets).
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.30.1';
import { withRetry } from "./withRetry.ts";

// ============================================================
// Types
// ============================================================
export interface CallAnthropicParams {
  /** Model identifier — e.g. 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001' */
  model: string;
  /** Messages array per Anthropic SDK shape */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Optional system prompt */
  system?: string;
  /** Max tokens for response. Required by Anthropic SDK. Default 4096. */
  maxTokens?: number;
  /** Temperature (0–1). Default 0.0 for determinism. */
  temperature?: number;
  /** Calling function's name — recorded in LLMUsage for cost-by-function reporting */
  functionName: string;
  /** Optional Claim ID — recorded in LLMUsage for per-claim cost analysis */
  claimId?: string | null;
  /** Optional Interaction ID — recorded in LLMUsage for per-interaction tracking */
  interactionId?: string | null;
  /** Use LLMCache. Defaults to true if temperature ≤ 0.1 (deterministic enough to cache). */
  useCache?: boolean;
  /** Cache TTL in hours. Default 24h. */
  cacheTtlHours?: number;
  /** Override default 30s function timeout safety margin (in ms). Default 25_000. */
  deadlineMs?: number;
}

export interface CallAnthropicResult {
  /** Response text. */
  text: string;
  /** Anthropic usage block. */
  usage: { input_tokens: number; output_tokens: number };
  /** True if served from LLMCache without an Anthropic API call. */
  cacheHit: boolean;
  /** Model used (echoed). */
  model: string;
  /** ISO timestamp when cached entry was created (only if cacheHit=true). */
  cachedAt?: string;
}

// ============================================================
// Cost rates (USD per 1M tokens). Update as Anthropic pricing changes.
// ============================================================
const COST_RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15.0, output: 75.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  // Default for unknown models — conservative estimate
  __default: { input: 3.0, output: 15.0 },
};

// ============================================================
// Inline-vs-externalize cap for cached response
// ============================================================
const CACHE_RESPONSE_INLINE_MAX_BYTES = 14_500;

// ============================================================
// SHA-256 helper for deterministic cache keys
// ============================================================
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Stable JSON stringify — sorts object keys recursively for deterministic output.
 */
function stableJSON(value: any): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

/**
 * Compute deterministic cache key from model + messages + params.
 */
async function computeCacheKey(p: CallAnthropicParams): Promise<string> {
  const canonical = stableJSON({
    model: p.model,
    messages: p.messages,
    system: p.system ?? null,
    maxTokens: p.maxTokens ?? 4096,
    temperature: p.temperature ?? 0.0,
  });
  return await sha256Hex(canonical);
}

// ============================================================
// Compute estimated cost
// ============================================================
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_RATES[model] ?? COST_RATES.__default;
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return Math.round((inputCost + outputCost) * 100000) / 100000;
}

// ============================================================
// Singleton Anthropic client
// ============================================================
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('anthropic-client: ANTHROPIC_API_KEY env var not set');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

// ============================================================
// Cache lookup — returns null on miss or expired
// ============================================================
async function checkCache(
  base44: any,
  cacheKey: string,
  model: string,
): Promise<{ text: string; tokens_input: number; tokens_output: number; cachedAt: string } | null> {
  try {
    const matches = await base44.asServiceRole.entities.LLMCache.filter(
      { prompt_hash: cacheKey, model },
      '-expires_at',
      1,
    );
    if (!matches || matches.length === 0) return null;
    const cached = matches[0];
    if (!cached?.expires_at) return null;
    if (new Date(cached.expires_at).getTime() <= Date.now()) {
      // Expired
      return null;
    }

    let text: string;
    if (cached.response_full_url) {
      // Externalized — fetch from CDN
      const resp = await fetch(cached.response_full_url);
      if (!resp.ok) return null; // CDN fetch failed; treat as cache miss
      text = await resp.text();
    } else {
      text = cached.response_summary || '';
    }

    return {
      text,
      tokens_input: cached.tokens_input || 0,
      tokens_output: cached.tokens_output || 0,
      cachedAt: cached.created_date || cached.expires_at,
    };
  } catch {
    // Cache lookup failed — treat as miss
    return null;
  }
}

// ============================================================
// Cache write — handles inline vs externalize based on size
// ============================================================
async function writeCache(
  base44: any,
  cacheKey: string,
  model: string,
  text: string,
  inputTokens: number,
  outputTokens: number,
  ttlHours: number,
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

    let response_summary = text;
    let response_full_url: string | null = null;

    if (text.length > CACHE_RESPONSE_INLINE_MAX_BYTES) {
      // Externalize to CDN
      try {
        const file = new File(
          [text],
          `llmcache_${cacheKey.slice(0, 16)}_${Date.now()}.txt`,
          { type: 'text/plain' },
        );
        const upload = await base44.integrations.Core.UploadFile({ file });
        if (upload?.file_url) {
          response_full_url = upload.file_url;
          response_summary = text.slice(0, CACHE_RESPONSE_INLINE_MAX_BYTES - 32) + '...[TRUNCATED:see full_url]';
        } else {
          // Upload failed — store truncated summary only
          response_summary = text.slice(0, CACHE_RESPONSE_INLINE_MAX_BYTES);
        }
      } catch {
        response_summary = text.slice(0, CACHE_RESPONSE_INLINE_MAX_BYTES);
      }
    }

    await base44.asServiceRole.entities.LLMCache.create({
      prompt_hash: cacheKey,
      model,
      response_summary,
      response_full_url,
      tokens_input: inputTokens,
      tokens_output: outputTokens,
      expires_at: expiresAt,
      is_test: false,
    });
  } catch {
    // Cache write failed — non-fatal; the call still succeeded
  }
}

// ============================================================
// LLMUsage record — fire-and-forget; failure non-fatal
// ============================================================
async function recordUsage(
  base44: any,
  params: CallAnthropicParams,
  inputTokens: number,
  outputTokens: number,
  cacheHit: boolean,
): Promise<void> {
  try {
    const cost = estimateCost(params.model, inputTokens, outputTokens);
    await base44.asServiceRole.entities.LLMUsage.create({
      function_name: params.functionName,
      model: params.model,
      tokens_input: inputTokens,
      tokens_output: outputTokens,
      estimated_cost_usd: cost,
      claim_id: params.claimId ?? null,
      interaction_id: params.interactionId ?? null,
      cache_hit: cacheHit,
      occurred_at: new Date().toISOString(),
      is_test: false,
    });
  } catch {
    // Usage logging failed — non-fatal
  }
}

// ============================================================
// Main entrypoint
// ============================================================
export async function callAnthropic(
  base44: any,
  params: CallAnthropicParams,
): Promise<CallAnthropicResult> {
  if (!params.functionName) {
    throw new Error('anthropic-client: functionName is required for usage tracking');
  }

  // Determine if caching applies
  const temperature = params.temperature ?? 0.0;
  const useCache = params.useCache ?? (temperature <= 0.1);
  const cacheTtlHours = params.cacheTtlHours ?? 24;
  const deadlineMs = params.deadlineMs ?? 25_000;

  let cacheKey: string | null = null;
  if (useCache) {
    cacheKey = await computeCacheKey(params);
    const cached = await checkCache(base44, cacheKey, params.model);
    if (cached) {
      // Cache hit — record usage as cache hit, return cached result
      await recordUsage(base44, params, cached.tokens_input, cached.tokens_output, true);
      return {
        text: cached.text,
        usage: { input_tokens: cached.tokens_input, output_tokens: cached.tokens_output },
        cacheHit: true,
        model: params.model,
        cachedAt: cached.cachedAt,
      };
    }
  }

  // Cache miss or caching disabled — call Anthropic
  const client = getClient();
  const startedAt = Date.now();

  const response = await withRetry(
    async () => {
      const resp = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        temperature,
        ...(params.system ? { system: params.system } : {}),
        messages: params.messages,
      });
      return resp;
    },
    {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      deadlineAt: Date.now() + deadlineMs,
      retryOn: (err: any) => {
        const status = err?.status;
        if (status === 401 || status === 403) return false; // auth — not retryable
        if (status === 400 || status === 404) return false; // request errors
        if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
        // Network errors usually surface without status code
        if (!status) return true;
        return false;
      },
    },
  );

  // Extract text from response
  const text = (response.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  // Record usage (always — both cache hits and misses)
  await recordUsage(base44, params, inputTokens, outputTokens, false);

  // Write to cache if caching is on
  if (useCache && cacheKey) {
    await writeCache(base44, cacheKey, params.model, text, inputTokens, outputTokens, cacheTtlHours);
  }

  return {
    text,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cacheHit: false,
    model: params.model,
  };
}
