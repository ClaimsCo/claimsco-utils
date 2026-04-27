/**
 * idempotencyGuard — pure check determining whether a handler should skip work
 * because the record indicates the action has already been completed.
 *
 * Background:
 * - Per Findings v6 URGENT 14, entity triggers may fire 7+ times at 10-15s
 *   cadence on transient failure. Combined with PendingJob heartbeat retries,
 *   a handler may invoke 10+ times for the same logical event.
 * - Per Findings v6 Section 8.1, handler idempotency is the load-bearing
 *   correctness mechanism. The conditional update primitive does not exist
 *   (Test 6 in P0-5b confirmed Entity.update's third arg is silently ignored),
 *   so handlers cannot rely on platform-side concurrency control.
 * - This utility is the canonical pattern: every handler's first check should
 *   be "have I already processed this record?" If yes, return 200 and exit.
 *
 * Usage pattern in a handler:
 *
 *   const interaction = await base44.asServiceRole.entities.Interaction.get(payload.entity_id);
 *   const guard = idempotencyGuard(interaction, 'ai_analyzed_at');
 *   if (guard.shouldSkip) {
 *     return new Response(guard.reason, { status: 200 });
 *   }
 *   // ... actual handler logic ...
 *   // At end, set ai_analyzed_at = new Date().toISOString() so subsequent
 *   // invocations skip.
 *
 * Pure function. No I/O, no side effects. Deterministic on inputs.
 *
 * Distinct from the dispatcher's optimistic-locking via dispatcher_claim_id.
 * That pattern claims a job for processing — prevents two dispatchers from
 * picking up the same job. This utility checks whether the work itself has
 * already been done — prevents repeating logic on a re-fired event.
 */

export interface IdempotencyGuardResult {
  /** True if the handler should skip (record already processed). */
  shouldSkip: boolean;
  /** Human-readable reason. Populated only when shouldSkip is true. */
  reason?: string;
}

/**
 * Check whether record[processedAtField] indicates already-processed.
 *
 * The field is considered "processed" when its value is anything other than
 * null, undefined, or empty string. Truthy timestamps, ISO strings, numbers,
 * and booleans all indicate processed.
 *
 * Defensive against missing record (returns shouldSkip: false so the caller
 * proceeds to load fresh state — better than silently swallowing).
 */
export function idempotencyGuard(
  record: any,
  processedAtField: string,
): IdempotencyGuardResult {
  if (!record || typeof record !== 'object') {
    return { shouldSkip: false };
  }

  if (!processedAtField || typeof processedAtField !== 'string') {
    return { shouldSkip: false };
  }

  const value = record[processedAtField];

  // Null, undefined, empty string: not processed
  if (value === null || value === undefined || value === '') {
    return { shouldSkip: false };
  }

  // Anything else: treat as processed
  return {
    shouldSkip: true,
    reason: `already_processed (${processedAtField}=${formatValue(value)})`,
  };
}

/**
 * Compact value formatter for the reason string. Avoids dumping large objects.
 */
function formatValue(value: any): string {
  if (typeof value === 'string') {
    return value.length > 64 ? `${value.slice(0, 60)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '<set>';
}
