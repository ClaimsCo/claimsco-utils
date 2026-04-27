/**
 * audit — write a record to the AuditLog entity with regulatory-grade integrity.
 *
 * Background:
 * - Per Findings v6, AuditLog has 7-year retention for insurance regulatory
 *   compliance. Writes must not silently fail.
 * - Per URGENT 15, concurrent writes can return HTTP 200 with payload silently
 *   discarded. This utility uses verify-write to detect silent discard, and
 *   escalates to ErrorLog on failure. We do NOT swallow audit failures.
 * - Per URGENT 13, individual string values are capped at ~20KB. The before/
 *   after state snapshots commonly exceed this (e.g., a Claim with full
 *   activity_log). When their JSON-stringified combined size exceeds 15KB,
 *   the utility uploads to CDN and stores summary + URL on the AuditLog
 *   record per Amendment v1.1.1 Section 2 split-or-externalize pattern.
 * - Per Phase 0 finding, platform-stamped created_by is unreliable across
 *   entity types. AuditLog uses application-stamped actor_email as the
 *   authoritative identity field.
 *
 * Default behavior is verify-write enabled. Audit trail integrity is
 * load-bearing for regulatory compliance; silent discard is unacceptable.
 *
 * Usage:
 *   await audit(base44, {
 *     actor_email: 'clifford@azclaimsco.com',
 *     action_type: 'claim_status_changed',
 *     target_entity: 'Claim',
 *     target_id: claim.id,
 *     before: { status: 'Submitted' },
 *     after: { status: 'Filed' },
 *     metadata: { reason: 'inspection_complete' },
 *   });
 */

export interface AuditParams {
  /** Application-populated actor identity. NOT platform-populated created_by. */
  actor_email: string;
  /** Stable action identifier. e.g., 'claim_status_changed', 'lor_signed'. */
  action_type: string;
  /** Entity name being audited. e.g., 'Claim', 'Interaction'. */
  target_entity: string;
  /** ID of the target record. */
  target_id: string;
  /** Pre-state. May be null/undefined for create actions. */
  before: any;
  /** Post-state. May be null/undefined for delete actions. */
  after: any;
  /** Optional context. Free-form object; kept under summary size budget. */
  metadata?: Record<string, any>;
  /** ISO 8601 UTC timestamp. Defaults to now() if omitted. */
  occurred_at?: string;
}

export interface AuditResult {
  /** ID of the created AuditLog record. */
  id: string;
  /** True if before/after were externalized to CDN due to size. */
  externalized: boolean;
}

/**
 * Threshold for combined before+after size (in bytes of JSON). Above this,
 * the utility externalizes to CDN. Set conservatively at 15KB to leave room
 * for safety margin within the 20KB-per-string-value platform cap.
 */
const SIZE_BUDGET_BYTES = 15_000;

/**
 * Maximum size of any single summary field. Conservative within URGENT 13.
 */
const SUMMARY_MAX_BYTES = 14_500;

/**
 * Truncate a JSON string to fit within max bytes. Adds ellipsis marker
 * indicating truncation occurred. The actual full content lives in CDN
 * when this happens.
 */
function truncateJSON(value: any, maxBytes: number): string {
  const json = safeStringify(value);
  if (json.length <= maxBytes) return json;
  return json.slice(0, maxBytes - 32) + '...[TRUNCATED:see full_url]';
}

/**
 * JSON.stringify with safety wrapper for circular references and BigInt.
 */
function safeStringify(value: any): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      return v;
    });
  } catch (err) {
    // Circular reference or unstringifiable: best-effort coercion
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (_key, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      });
    } catch {
      return `[Unstringifiable: ${String(err)}]`;
    }
  }
}

/**
 * Upload a JSON string to Base44 CDN via Core.UploadFile and return the URL.
 * Used when before/after state exceeds inline size budget.
 */
async function uploadJSONToCDN(
  base44: any,
  json: string,
  filename: string,
): Promise<string> {
  // Construct a Blob/File from the JSON string. Deno's File constructor accepts
  // strings as the parts array — common pattern in Base44 functions.
  const file = new File([json], filename, { type: 'application/json' });
  const result = await base44.integrations.Core.UploadFile({ file });
  if (!result?.file_url) {
    throw new Error('audit: UploadFile returned no file_url');
  }
  return result.file_url;
}

/**
 * Verify-write loop for AuditLog. Re-reads after create and confirms the
 * actor_email and action_type fields landed. If not, retries.
 *
 * AuditLog is append-only (update/delete RLS blocks all roles per Amendment
 * v1.1.1 Section 1.1). Retry is via a NEW create call — we cannot patch a
 * lost write. If a previous attempt actually persisted, we'll have a
 * duplicate AuditLog row. Acceptable trade-off: duplicate audit entry is
 * less harmful than missing audit entry.
 */
async function createWithVerify(
  base44: any,
  record: any,
  maxRetries: number,
  retryDelayMs: number,
): Promise<{ id: string }> {
  let lastError: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const created = await base44.asServiceRole.entities.AuditLog.create(record);
      if (!created?.id) {
        throw new Error('audit: AuditLog.create returned no id');
      }

      // Verify by reading back
      await sleep(retryDelayMs);
      let actual: any = null;
      try {
        actual = await base44.asServiceRole.entities.AuditLog.get(created.id);
      } catch {
        // Read failed; treat as silent_discard suspect, retry
        lastError = new Error('audit: verify-read failed after create');
        continue;
      }

      // Field-level verify on the must-land identity fields
      if (
        actual?.actor_email === record.actor_email &&
        actual?.action_type === record.action_type &&
        actual?.target_id === record.target_id
      ) {
        return { id: created.id };
      }

      // Silent discard: retry with new create
      lastError = new Error(
        'audit: silent_discard — fields did not reflect on read-back',
      );
      continue;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw lastError ?? new Error('audit: write failed after max retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function audit(
  base44: any,
  params: AuditParams,
): Promise<AuditResult> {
  // Validate required inputs
  if (!params.actor_email || typeof params.actor_email !== 'string') {
    throw new Error('audit: actor_email is required');
  }
  if (!params.action_type) throw new Error('audit: action_type is required');
  if (!params.target_entity) throw new Error('audit: target_entity is required');
  if (!params.target_id) throw new Error('audit: target_id is required');

  const occurred_at = params.occurred_at ?? new Date().toISOString();

  // Compute before/after sizes and decide split-or-externalize
  const beforeJson = safeStringify(params.before ?? null);
  const afterJson = safeStringify(params.after ?? null);
  const combinedSize = beforeJson.length + afterJson.length;

  let before_summary: string | null = null;
  let before_full_url: string | null = null;
  let after_summary: string | null = null;
  let after_full_url: string | null = null;
  let externalized = false;

  if (combinedSize <= SIZE_BUDGET_BYTES) {
    // Both fit inline
    before_summary = params.before == null ? null : beforeJson;
    after_summary = params.after == null ? null : afterJson;
  } else {
    // Externalize the larger one(s) to CDN
    externalized = true;
    const filenamePrefix = `audit_${params.target_entity}_${params.target_id}_${Date.now()}`;

    if (params.before != null) {
      if (beforeJson.length > SUMMARY_MAX_BYTES) {
        before_full_url = await uploadJSONToCDN(
          base44,
          beforeJson,
          `${filenamePrefix}_before.json`,
        );
        before_summary = truncateJSON(params.before, SUMMARY_MAX_BYTES);
      } else {
        before_summary = beforeJson;
      }
    }

    if (params.after != null) {
      if (afterJson.length > SUMMARY_MAX_BYTES) {
        after_full_url = await uploadJSONToCDN(
          base44,
          afterJson,
          `${filenamePrefix}_after.json`,
        );
        after_summary = truncateJSON(params.after, SUMMARY_MAX_BYTES);
      } else {
        after_summary = afterJson;
      }
    }
  }

  // Build the AuditLog record
  const record = {
    actor_email: params.actor_email,
    action_type: params.action_type,
    target_entity: params.target_entity,
    target_id: params.target_id,
    before_summary,
    before_full_url,
    after_summary,
    after_full_url,
    metadata: params.metadata ?? null,
    occurred_at,
  };

  // Create with verify-write
  const result = await createWithVerify(base44, record, 3, 100);

  return { id: result.id, externalized };
}
