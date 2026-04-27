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
| Visibility | Public (required for unauthenticated Deno URL imports) |
| Sub-phase A empirical verification | ✅ Passed 2026-04-27 (mergeUpdate, withRetry, idempotencyGuard imported from blessed SHAs into a Base44 function; deploy + runtime tests all passed) |
| Sub-phase C empirical verification | ✅ Passed 2026-04-27 (audit imported from blessed SHA into a Base44 function; inline + externalization E2E tests all passed against deployed AuditLog entity) |

---

## SHA-pinning policy

**Required pattern in every Base44 function import:**

```typescript
import { mergeUpdate } from "https://raw.githubusercontent.com/ClaimsCo/claimsco-utils/368a2e2c5779a04a74cac33c7c09539c918ead97/src/mergeUpdate.ts";
```

The 40-character hex string is the immutable commit SHA. Until/unless the main app codebase migrates to a Git-based deploy pipeline, SHA-pinning compliance is enforced via:

1. App Thread generates SHA-pinned URLs by default in every code emission
2. Strategy thread reviews each Phase 1+ prompt for SHA-pinning compliance
3. Code-review discipline as functions ship through Build mode

The originally-planned `validate-imports.sh` pre-deploy hook is deferred until the main app codebase is on Git (likely Phase 2+ acquisition prep).

**Rejected patterns:**
- Branch refs: `claimsco-utils/main/src/...` ❌ (mutable; today and tomorrow can resolve to different code)
- Short SHAs: `claimsco-utils/abc123/src/...` ❌ (collision risk; not enforced as immutable by GitHub)
- Tags: `claimsco-utils/v1.0/src/...` ❌ (we don't tag; rejecting tag refs prevents accidental tag-based imports)

---

## Utility-update workflow

To bump a utility:

1. **Branch + edit + test** in the claimsco-utils repo. Run `deno test tests/integration.ts`.
2. **PR + merge to main.** Merge commit SHA is the candidate new blessed SHA.
3. **Update this document.** Move the previous Blessed SHA to the Change log section. Set the new SHA as Blessed.
4. **Deploy consuming functions one at a time.** Each consuming function's import URL updates to the new SHA.
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
    retryDelayMs?: number;      // default 100
  }
): Promise<{
  success: boolean;
  finalState: T;
  failureReason?: 'silent_discard' | 'read_failed' | 'write_failed';
  divergedFields?: string[];
}>;
```

**Behavior summary:** Reads current entity state, deep-merges the patch into it, writes the merged result. Default behavior fires-and-trusts. With `verifyWrite: true`, re-reads after the write and compares the patched fields against expected values; on mismatch, retries up to `maxRetries` times. On final mismatch returns `{ success: false, failureReason: 'silent_discard' }` so the caller can escalate (e.g., write `error_type: 'silent_discard'` to ErrorLog).

Deep-merge replaces arrays wholesale by default. For appending to array fields (e.g., `activity_log`), use `appendArrayField` instead.

**Use case:** Standard updates to entities. Set `verifyWrite: true` for fields known to be contention-prone (e.g., `Claim.activity_log` accessed by multiple triggers, `Interaction.ai_analyzed_at` set by analyze-and-embed handler). Default-false on most calls keeps the read overhead off the hot path.

**Read replica lag mitigation (Phase 1 finding from C2.2):** The platform may serve stale state on get-after-update for tens-to-hundreds of milliseconds after a write. `verifyWrite: true` with `retryDelayMs ≥ 100ms` naturally catches this — the small window between write commit and read replica catch-up resolves on retry. For verification-critical paths where exact post-update state must be confirmed before proceeding, prefer `mergeUpdate` over direct `Entity.update()` followed by immediate `Entity.get()`.

**Blessed SHA:** `368a2e2c5779a04a74cac33c7c09539c918ead97`

**Consuming functions:** (none yet — populated as Phase 1+ functions adopt)

**Change log:** Initial blessed SHA committed 2026-04-27.

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
    onRetry?: (info: { attempt; error; delayMs }) => void; // optional observability hook
  }
): Promise<T>;
```

**Behavior summary:** Calls `fn()`. On failure that matches `retryOn`, waits with exponential backoff `min(baseDelayMs × 2^attempt, maxDelayMs)` (multiplied by random factor 0.5–1.5 if `jitter: true`) and retries up to `maxRetries` times. Default `retryOn` retries on HTTP 5xx, network errors, and 429 rate-limit responses. Does NOT retry 4xx (other than 429), invalid input, or assertion errors.

**Deadline awareness:** if `deadlineAt` is provided, the next backoff sleep is capped so it doesn't exceed the deadline. If a retry would exceed the deadline, throws the last error immediately rather than burning the function's 30s budget on a sleep that runs out the clock. Recommended: `deadlineAt: Date.now() + 25_000` for inline calls (5s buffer); use PendingJob retry for longer work.

**Use case:** Wrap every outbound HTTPS call (Anthropic, NOAA, Voyage, Gmail API). Wrap entity-API calls that may hit transient platform 502s. Do not wrap dispatcher-internal logic (the dispatcher has its own retry policy).

**Blessed SHA:** `204b58f605d73e28bac7d14b2997c87ed02e8b19`

**Consuming functions:** (none yet)

**Change log:** Initial blessed SHA committed 2026-04-27.

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
    is_test?: boolean;           // mark as test scaffolding for filterability; defaults to false
  }
): Promise<{ id: string; externalized: boolean }>;
```

**Behavior summary:** Creates an `AuditLog` record. Uses verify-write semantics (per URGENT 15) — audit trail integrity is load-bearing for regulatory compliance, so silent discard is unacceptable. If `before+after` JSON-stringified together exceeds 15KB, the utility uploads the full state to Base44 CDN via `Core.UploadFile` and stores summary + URL on the AuditLog record (per URGENT 13's split-or-externalize pattern, with a 14.5KB summary cap to leave headroom under the 20KB platform limit).

`actor_email` is application-populated. Platform-stamped `created_by` is unreliable across entity types (per Phase 0 finding) and may surface as a service-account UUID; the AuditLog spec treats `actor_email` as the authoritative identity field.

**`is_test` parameter:** Passes through to the `is_test` field on the AuditLog record. Defaults to false (production audit entry). Set to true for test-scaffolding records that should be filterable for cleanup or downstream test queries. Production code should never pass true.

**Verify-write retry semantics:** AuditLog is append-only (`update`/`delete` blocked by `role: "never"`), so retry creates a NEW row rather than patching a lost write. Trade-off: duplicate AuditLog entries possible on retry. Acceptable — duplicates can be deduplicated downstream (P1-9 nightly consistency check); missing entries cannot be recreated.

**Use case:** Every state-changing handler in Phase 1+ writes an AuditLog entry: claim status transitions, LOR signing, contractor invitations, dispute round changes, financial adjustments, role changes, document uploads. Reads do not audit unless they're sensitive (e.g., admin viewing financial fields).

**CDN public-access convention (Phase 1 design rule 19):** `audit()` externalization writes payloads to public CDN URLs with predictable obscurity-only naming (`audit_{entity}_{id}_{timestamp}_{before|after}.json`). Callers MUST NOT pass full PII state in `before`/`after` — store identifying metadata and state-transition deltas, not raw PII. If preserving full PII state is needed, store elsewhere with proper access control and reference by ID in audit metadata. URLs are not cryptographically protected; obscurity is the only barrier to access.

**Blessed SHA:** `7d4250d65f546f80f06784733d485a13d82ce7f4`

**Consuming functions:** (none yet)

**Change log:**
- 2026-04-27 (commit `7d4250d65f546f80f06784733d485a13d82ce7f4`): Hygiene revision — added `is_test?: boolean` parameter to audit options for test-scaffolding filter support; default false matches prior production behavior. JSDoc enhanced with CDN public-access concern note and read-replica-lag context. Previous SHA: `331e524197d5ca95825a936b253f4f9378a85281`.
- 2026-04-27 (initial commit `331e524197d5ca95825a936b253f4f9378a85281`): Initial blessed SHA. Superseded.

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

**Behavior summary:** Inspects `record[processedAtField]`. If non-null, non-undefined, non-empty-string, returns `{ shouldSkip: true, reason: 'already_processed (...)' }`. Otherwise returns `{ shouldSkip: false }`. Pure function — no I/O, no side effects.

**Use case:** First check inside any PendingJob handler or trigger handler. After loading the record by ID, run the guard and return 200 immediately if it says skip. Per URGENT 14, triggers may fire 7+ times on transient failure; combined with PendingJob heartbeat retries, a handler may invoke 10+ times for the same logical event. The guard is the load-bearing correctness mechanism that makes those re-invocations safe.

Distinct from the dispatcher's `dispatcher_claim_id` optimistic-locking pattern (which prevents two dispatchers from picking up the same job). This utility is for handlers checking whether the work itself has already been done.

**Blessed SHA:** `55a44811f254738ff1491fc6a3226ceb5703a9ba`

**Consuming functions:** (none yet)

**Change log:** Initial blessed SHA committed 2026-04-27.

---

### `appendArrayField`

**Source:** `src/appendArrayField.ts`

**Signature:**

```typescript
export async function appendArrayField<T>(
  entity: any,
  id: string,
  fieldName: string,
  newEntries: T[],
  options?: {
    verifyWrite?: boolean;            // default true (audit safety)
    maxRetries?: number;              // default 3
    preflightSizeCheck?: boolean;     // default true (URGENT 13)
    maxStringValueBytes?: number;     // default 20000
    retryDelayMs?: number;            // default 100
  }
): Promise<{
  success: boolean;
  finalLength: number;
  rejectedEntries: T[];
  failureReason?: 'silent_discard' | 'read_failed' | 'write_failed' | 'field_not_array';
}>;
```

**Behavior summary:** Reads entity, validates `entity[fieldName]` is an array (throws if not), preflight-scans each new entry for any string value exceeding `maxStringValueBytes` (rejects oversized entries individually rather than failing the whole batch), concatenates accepted entries onto the existing array, writes via `entity.update`. With `verifyWrite: true` (default), re-reads and confirms the array length increased by the expected count; retries on mismatch.

**Verify-write retry semantics:** unlike `mergeUpdate`, retries do NOT re-merge. If actual length ≥ expected, treat as success (our entries — or equivalent count from a concurrent writer — are present). If actual length < expected, append accepted entries to current state and re-write. **Tolerant of concurrent appenders by design.** Does NOT guarantee exact entry order under contention.

Returns `rejectedEntries` so callers can decide whether to externalize oversized content (e.g., upload to CDN, store URL) and re-attempt with smaller payloads.

**Use case:** Any append to an array-typed entity field. Specifically: `Claim.activity_log` (audit trail), `Claim.interactions` (correspondence log), and any future array fields where appending is the access pattern. Code review rule: "Are you appending to an array entity field? Use `appendArrayField`."

**Blessed SHA:** `97d7de098b9aedf2714b9e09594a6108804c7d19`

**Consuming functions:** (none yet)

**Change log:** Initial blessed SHA committed 2026-04-27.

---

## Future utilities (added in subsequent sub-phases)

`anthropic-client` (Sub-phase D Item D4) — singleton wrapping `npm:@anthropic-ai/sdk` with `withRetry` + LLMCache + LLMUsage logging.

Other utilities discovered during Phase 1 entity work will be added here following the same pattern.

---

## Platform query API notes

Empirical findings on Base44's entity filter API behavior. Useful for utility authors and handler authors writing query-heavy code.

### Comparison operators

| Operator | Status | First confirmed | Use case |
|---|---|---|---|
| `=` (plain equality) | Supported | Phase 0 | `{ status: 'Filed' }` |
| `$or` | Supported | Phase 0 | RLS rules with multiple identity branches |
| `$regex` | Supported | Phase 0 | RLS email-pattern matching, text-search filters |
| `$lt` | Supported | Phase 1 C2.3 | Cleanup tasks: `{ expires_at: { $lt: nowIso } }` |
| `$gt` | Likely supported (untested) | — | Probable: `{ occurred_at: { $gt: oneHourAgoIso } }` |
| `$gte` | Likely supported (untested) | — | Same family as `$lt` |
| `$lte` | Likely supported (untested) | — | Same family as `$lt` |

**Convention:** if you need an operator outside the empirically-confirmed set, validate it once in a small test against the relevant entity before depending on it in production code. The MongoDB-style operator family is the platform's pattern but not all operators have been individually confirmed.

### Default limits

- Filter without explicit limit returns all matching rows (no default cap, per URGENT 1 RESOLVED in Phase 0). Performance hygiene: pass an explicit `limit` argument on every filter call.

### Comparison evaluation

- `$lt` is strictly less-than. Boundary values (exactly equal to the comparison target) are NOT included. Mirrors MongoDB semantics.

---

## Audit / grep notes

To find all functions importing a specific utility version:

```bash
grep -r "claimsco-utils/<SHA>/src/<utility>.ts" base44/functions/
```

To find any utility imports across the codebase:

```bash
grep -r "raw.githubusercontent.com/ClaimsCo/claimsco-utils" base44/functions/
```

These commands provide audit answers without requiring runtime introspection of any deployed function.
