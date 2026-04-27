# claimsco-utils — Utility Reference

Canonical reference for every utility in this repo. Every Phase 1+ Base44 function importing from this repo MUST pin to a specific 40-character commit SHA listed in this document.

This document is the single source of truth for "which version of which utility is currently blessed for production use."

---

## How to read this doc

Each utility section contains:

- **Signature** — exact TypeScript signature exported from the file
- **Behavior summary** — what the function does, in one paragraph
- **Use case** — when handlers should use this utility
- **Blessed SHA** — current production-blessed commit SHA. Phase 1+ functions import using this exact SHA.
- **Consuming functions** — list of Base44 functions currently importing this utility. Updated as functions adopt.
- **Change log** — append-only record of SHA bumps with date and rationale.

When a utility is updated, the new SHA replaces the old in the Blessed SHA field. The previous SHA is preserved in the Change log section.

---

## Repo state

| Field | Value |
|---|---|
| Repo URL | https://github.com/ClaimsCo/claimsco-utils |
| Raw URL pattern | `https://raw.githubusercontent.com/ClaimsCo/claimsco-utils/<SHA>/src/<filename>` |
| Initial README commit SHA | `964414fa5dc863cec3048184741b08b67d3a1f3b` |
| Visibility | Public (required for unauthenticated Deno URL imports) |

---

## SHA-pinning policy

**Required pattern in every Base44 function import:**

```typescript
import { mergeUpdate } from "https://raw.githubusercontent.com/ClaimsCo/claimsco-utils/abc123def4567890abc123def4567890abc12345/src/mergeUpdate.ts";
```

The 40-character hex string is the immutable commit SHA. This is enforced by `validate-imports.sh` in the main app repo, run pre-deployment.

**Rejected patterns:**
- Branch refs: `claimsco-utils/main/src/...` ❌ (mutable; today and tomorrow can resolve to different code)
- Short SHAs: `claimsco-utils/abc123/src/...` ❌ (collision risk; not enforced as immutable by GitHub)
- Tags: `claimsco-utils/v1.0/src/...` ❌ (we don't tag; rejecting tag refs prevents accidental tag-based imports)

**Why role-based read on `validate-imports.sh`:** the script greps function source for the URL pattern and asserts the SHA segment is 40 hex chars. No external API call to GitHub. Works offline; works in CI; works pre-deploy.

---

## Utility-update workflow

To bump a utility:

1. **Branch + edit + test** in the claimsco-utils repo. Run `deno test tests/<utilityName>.test.ts`.
2. **PR + merge to main.** Merge commit SHA is the candidate new blessed SHA.
3. **Update this document.** Move the previous Blessed SHA to the Change log section. Set the new SHA as Blessed.
4. **Deploy consuming functions one at a time.** Each consuming function's import URL updates to the new SHA. Run `validate-imports.sh` before each deploy.
5. **Audit post-deploy.** Spot-check function execution logs to confirm new utility version executes as expected. If regression, revert by re-deploying the function with the previous SHA.

The previous SHA remains immutably accessible — rollback is just re-deploy with the old import URL.

---

## Utilities

### `mergeUpdate`

**Source:** `src/mergeUpdate.ts`

**Signature:**

```typescript
export async function mergeUpdate<T>(
  entity: any,
  id: string,
  patch: Partial<T>,
  options?: {
    verifyWrite?: boolean;     // default false
    maxRetries?: number;        // default 3
    reMergeOnRetry?: boolean;   // default true
    strictCompare?: boolean;    // default false (patch-only compare)
  }
): Promise<{ success: boolean; finalState: T }>;
```

**Behavior summary:** Reads current entity state, deep-merges the patch into it, writes the merged result. Default behavior fires-and-trusts. With `verifyWrite: true`, re-reads after the write and compares the patched fields against expected values; on mismatch, retries up to `maxRetries` times. On final mismatch returns `{ success: false }` so the caller can escalate (e.g., write `error_type: 'silent_discard'` to ErrorLog).

Deep-merge replaces arrays wholesale by default. For appending to array fields (e.g., `activity_log`), use the `appendArrayField` utility instead.

**Use case:** Standard updates to entities. Set `verifyWrite: true` for fields known to be contention-prone (e.g., `Claim.activity_log` accessed by multiple triggers, `Interaction.ai_analyzed_at` set by analyze-and-embed handler). Default-false on most calls keeps the read overhead off the hot path.

**Blessed SHA:** TBD (pending File 3 commit)

**Consuming functions:** (none yet — populated as Phase 1+ functions adopt)

**Change log:** (none yet)

---

### `withRetry`

**Source:** `src/withRetry.ts`

**Signature:**

```typescript
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;                        // default 3
    baseDelayMs?: number;                       // default 250
    maxDelayMs?: number;                        // default 5000
    jitter?: boolean;                           // default true
    retryOn?: (err: any) => boolean;            // default: 5xx, network, 429
    deadlineAt?: number;                        // optional Date.now()-ms deadline
  }
): Promise<T>;
```

**Behavior summary:** Calls `fn()`. On failure that matches `retryOn`, waits with exponential backoff `min(baseDelayMs × 2^attempt, maxDelayMs)` (multiplied by random factor 0.5–1.5 if `jitter: true`) and retries up to `maxRetries` times. Default `retryOn` retries on HTTP 5xx, network errors, and 429 rate-limit responses. Does NOT retry 4xx (other than 429), invalid input, or assertion errors.

**Deadline awareness:** if `deadlineAt` is provided, the next backoff sleep is capped so it doesn't exceed the deadline. If a retry would exceed the deadline, throws the last error immediately rather than burning the function's 30s budget on a sleep that runs out the clock. Recommend setting `deadlineAt: Date.now() + 25_000` for inline calls (5s buffer) and using PendingJob retry instead for longer work.

**Use case:** Wrap every outbound HTTPS call (Anthropic, NOAA, Voyage, Gmail API). Wrap entity-API calls that may hit transient platform 502s. Do not wrap dispatcher-internal logic (the dispatcher has its own retry policy).

**Blessed SHA:** TBD (pending File 4 commit)

**Consuming functions:** (none yet)

**Change log:** (none yet)

---

### `audit`

**Source:** `src/audit.ts`

**Signature:**

```typescript
export async function audit(
  base44: any,
  params: {
    actor_email: string;        // app-stamped, NOT platform-stamped
    action_type: string;
    target_entity: string;
    target_id: string;
    before: any;                 // pre-state
    after: any;                  // post-state
    metadata?: Record<string, any>;
    occurred_at?: string;        // ISO 8601 UTC; defaults to now()
  }
): Promise<{ id: string }>;
```

**Behavior summary:** Creates an `AuditLog` record. Uses verify-write semantics (per URGENT 15) — audit trail integrity is load-bearing for regulatory compliance, so silent discard is unacceptable here. If `before+after` JSON-stringified together exceeds 15KB, the utility uploads the full state to Base44 CDN and stores summary + URL on the AuditLog record (per URGENT 13's split-or-externalize pattern).

`actor_email` is application-populated. Platform-stamped `created_by` is unreliable across entity types (per Phase 0 finding) and may surface as a service-account UUID; the AuditLog spec treats `actor_email` as the authoritative identity field.

**Use case:** Every state-changing handler in Phase 1+ writes an AuditLog entry: claim status transitions, LOR signing, contractor invitations, dispute round changes, financial adjustments, role changes, document uploads. Reads do not audit unless they're sensitive (e.g., admin viewing financial fields).

**Blessed SHA:** TBD (pending File 5 commit)

**Consuming functions:** (none yet)

**Change log:** (none yet)

---

### `idempotencyGuard`

**Source:** `src/idempotencyGuard.ts`

**Signature:**

```typescript
export function idempotencyGuard(
  record: any,
  processedAtField: string
): { shouldSkip: boolean; reason?: string };
```

**Behavior summary:** Inspects `record[processedAtField]`. If non-null, returns `{ shouldSkip: true, reason: 'already_processed' }`. Otherwise returns `{ shouldSkip: false }`. Pure function — does not call the entity API.

**Use case:** First check inside any PendingJob handler or trigger handler. After loading the record by ID, run the guard and return 200 immediately if it says skip. Per URGENT 14, triggers may fire 7+ times on transient failure; combined with PendingJob heartbeat retries, a handler may invoke 10+ times for the same logical event. The guard is the load-bearing correctness mechanism that makes those re-invocations safe.

Distinct from the dispatcher's `dispatcher_claim_id` optimistic-locking pattern. The dispatcher pattern claims a job for processing; this utility is for handlers checking whether the work itself is already done.

**Blessed SHA:** TBD (pending File 6 commit)

**Consuming functions:** (none yet)

**Change log:** (none yet)

---

## Utilities pending strategy thread decision

`appendArrayField` — a small utility for appending entries to array-typed fields with proper read-spread-write-and-URGENT-15-verify semantics, plus URGENT 13 per-string-value size guards. Pending strategy thread direction in the App Thread Choice 1 review. If approved, will ship as `src/appendArrayField.ts` and get its own section above.

---

## Future utilities (added in subsequent sub-phases)

`anthropic-client` (Sub-phase D Item D4) — singleton wrapping `npm:@anthropic-ai/sdk` with `withRetry` + LLMCache + LLMUsage logging.

Other utilities discovered during Phase 1 entity work will be added here following the same pattern.

---

## Audit / grep notes

To find all functions importing a specific utility version:

```bash
grep -r "claimsco-utils/<SHA>/src/<utility>.ts" base44/functions/
```

To find any non-SHA-pinned imports:

```bash
bash scripts/validate-imports.sh
```

These commands provide audit answers without requiring runtime introspection of any deployed function.
