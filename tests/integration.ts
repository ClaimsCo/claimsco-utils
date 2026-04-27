/**
 * tests/integration.ts — Happy-path integration tests for all 5 utilities.
 *
 * Run from repo root:
 *   deno test tests/integration.ts
 *
 * These tests exercise core contracts using inline fake-entity stubs. They do
 * not require a live Base44 connection. Per-utility edge-case tests are
 * deferred to Phase 2 hardening.
 *
 * Coverage:
 *   - mergeUpdate: deep-merge semantics, verify-write success and silent-
 *     discard detection
 *   - withRetry: retry-on-5xx, no-retry-on-4xx, deadline-aware abort
 *   - audit: small-payload inline path, large-payload externalization path
 *   - idempotencyGuard: pure-function skip/proceed determinations
 *   - appendArrayField: append + verify, oversized-entry rejection,
 *     concurrent-append tolerance
 */

import {
  mergeUpdate,
} from "../src/mergeUpdate.ts";
import {
  withRetry,
} from "../src/withRetry.ts";
import {
  audit,
} from "../src/audit.ts";
import {
  idempotencyGuard,
} from "../src/idempotencyGuard.ts";
import {
  appendArrayField,
} from "../src/appendArrayField.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// =============================================================================
// Fake entity factory — used by mergeUpdate, appendArrayField tests
// =============================================================================

interface FakeEntity {
  get(id: string): Promise<any>;
  update(id: string, value: any): Promise<void>;
  _peek(): any;
  _setStorage(value: any): void;
  _setUpdateBehavior(fn: ((id: string, value: any) => Promise<void>) | null): void;
  _resetCallCount(): void;
  _getUpdateCallCount(): number;
}

function makeFakeEntity(initial: any): FakeEntity {
  let storage = JSON.parse(JSON.stringify(initial));
  let customUpdate: ((id: string, value: any) => Promise<void>) | null = null;
  let updateCalls = 0;

  return {
    async get(_id: string) {
      return JSON.parse(JSON.stringify(storage));
    },
    async update(id: string, value: any) {
      updateCalls++;
      if (customUpdate) return customUpdate(id, value);
      storage = JSON.parse(JSON.stringify(value));
    },
    _peek() {
      return JSON.parse(JSON.stringify(storage));
    },
    _setStorage(value: any) {
      storage = JSON.parse(JSON.stringify(value));
    },
    _setUpdateBehavior(fn) {
      customUpdate = fn;
    },
    _resetCallCount() {
      updateCalls = 0;
    },
    _getUpdateCallCount() {
      return updateCalls;
    },
  };
}

// =============================================================================
// Fake base44 client factory — used by audit tests
// =============================================================================

function makeFakeBase44(): {
  client: any;
  _getAuditLogRows(): any[];
  _getUploadedFiles(): { name: string; size: number; url: string }[];
} {
  const auditLogRows: any[] = [];
  const uploadedFiles: { name: string; size: number; url: string }[] = [];
  let fileCounter = 0;

  return {
    client: {
      asServiceRole: {
        entities: {
          AuditLog: {
            async create(record: any) {
              const newRow = {
                id: `audit_${auditLogRows.length + 1}`,
                ...JSON.parse(JSON.stringify(record)),
              };
              auditLogRows.push(newRow);
              return { id: newRow.id };
            },
            async get(id: string) {
              const row = auditLogRows.find((r) => r.id === id);
              if (!row) throw new Error(`AuditLog ${id} not found`);
              return JSON.parse(JSON.stringify(row));
            },
          },
        },
      },
      integrations: {
        Core: {
          async UploadFile({ file }: { file: File }) {
            fileCounter++;
            const url = `https://fake-cdn.test/uploads/${fileCounter}_${file.name}`;
            uploadedFiles.push({
              name: file.name,
              size: file.size,
              url,
            });
            return { file_url: url };
          },
        },
      },
    },
    _getAuditLogRows() {
      return JSON.parse(JSON.stringify(auditLogRows));
    },
    _getUploadedFiles() {
      return [...uploadedFiles];
    },
  };
}

// =============================================================================
// idempotencyGuard tests (pure function, fastest)
// =============================================================================

Deno.test("idempotencyGuard: returns shouldSkip=true on processed record", () => {
  const result = idempotencyGuard(
    { ai_analyzed_at: "2026-04-26T12:00:00Z" },
    "ai_analyzed_at",
  );
  assertEquals(result.shouldSkip, true);
  assertExists(result.reason);
  assert(result.reason!.includes("already_processed"));
  assert(result.reason!.includes("ai_analyzed_at"));
});

Deno.test("idempotencyGuard: returns shouldSkip=false on null field", () => {
  const result = idempotencyGuard(
    { ai_analyzed_at: null },
    "ai_analyzed_at",
  );
  assertEquals(result.shouldSkip, false);
  assertEquals(result.reason, undefined);
});

Deno.test("idempotencyGuard: returns shouldSkip=false on missing field", () => {
  const result = idempotencyGuard(
    { other_field: "set" },
    "ai_analyzed_at",
  );
  assertEquals(result.shouldSkip, false);
});

Deno.test("idempotencyGuard: returns shouldSkip=false on empty string", () => {
  const result = idempotencyGuard(
    { ai_analyzed_at: "" },
    "ai_analyzed_at",
  );
  assertEquals(result.shouldSkip, false);
});

Deno.test("idempotencyGuard: defensive on null record", () => {
  const result = idempotencyGuard(null, "ai_analyzed_at");
  assertEquals(result.shouldSkip, false);
});

Deno.test("idempotencyGuard: truncates long string values in reason", () => {
  const longTimestamp = "2026-04-26T12:00:00Z" + "x".repeat(200);
  const result = idempotencyGuard(
    { ai_analyzed_at: longTimestamp },
    "ai_analyzed_at",
  );
  assertEquals(result.shouldSkip, true);
  assert(result.reason!.length < 200, "reason should be truncated");
  assert(result.reason!.includes("..."));
});

// =============================================================================
// withRetry tests
// =============================================================================

Deno.test("withRetry: retries on synthetic 503 then succeeds", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) {
        const err: any = new Error("synthetic 503");
        err.status = 503;
        throw err;
      }
      return "success";
    },
    { maxRetries: 3, baseDelayMs: 10, jitter: false },
  );
  assertEquals(result, "success");
  assertEquals(attempts, 3);
});

Deno.test("withRetry: does NOT retry on synthetic 400", async () => {
  let attempts = 0;
  await assertRejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          const err: any = new Error("synthetic 400");
          err.status = 400;
          throw err;
        },
        { maxRetries: 3, baseDelayMs: 10 },
      ),
    Error,
    "synthetic 400",
  );
  assertEquals(attempts, 1);
});

Deno.test("withRetry: retries on 429", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 2) {
        const err: any = new Error("rate limited");
        err.status = 429;
        throw err;
      }
      return "ok";
    },
    { maxRetries: 3, baseDelayMs: 10, jitter: false },
  );
  assertEquals(result, "ok");
  assertEquals(attempts, 2);
});

Deno.test("withRetry: respects deadlineAt by aborting before late sleep", async () => {
  let attempts = 0;
  const startedAt = Date.now();
  // Set a deadline that's only 50ms out — second backoff (~20ms) would
  // succeed but third backoff (~40ms) would push past
  await assertRejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          const err: any = new Error("synthetic 503");
          err.status = 503;
          throw err;
        },
        {
          maxRetries: 5,
          baseDelayMs: 20,
          jitter: false,
          deadlineAt: startedAt + 50,
        },
      ),
    Error,
    "synthetic 503",
  );
  // Should NOT have attempted all 6 (1 initial + 5 retries) — should abort
  assert(
    attempts < 6,
    `deadline should have aborted retries; got ${attempts} attempts`,
  );
});

Deno.test("withRetry: maxRetries=0 means no retries", async () => {
  let attempts = 0;
  await assertRejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          const err: any = new Error("synthetic 503");
          err.status = 503;
          throw err;
        },
        { maxRetries: 0 },
      ),
  );
  assertEquals(attempts, 1);
});

Deno.test("withRetry: onRetry hook fires on each retry", async () => {
  const calls: { attempt: number; delayMs: number }[] = [];
  let attempts = 0;
  await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) {
        const err: any = new Error("503");
        err.status = 503;
        throw err;
      }
      return "ok";
    },
    {
      maxRetries: 3,
      baseDelayMs: 10,
      jitter: false,
      onRetry: ({ attempt, delayMs }) => {
        calls.push({ attempt, delayMs });
      },
    },
  );
  assertEquals(calls.length, 2, "onRetry fires once per retry");
  assertEquals(calls[0].attempt, 0);
  assertEquals(calls[1].attempt, 1);
});

// =============================================================================
// mergeUpdate tests
// =============================================================================

Deno.test("mergeUpdate: deep merges nested objects without losing keys", async () => {
  const entity = makeFakeEntity({
    id: "test",
    nested: { a: 1, b: 2 },
    list: [1, 2],
  });
  const result = await mergeUpdate(entity, "test", {
    nested: { b: 99, c: 3 },
  });
  assertEquals(result.success, true);
  const final = entity._peek();
  assertEquals(final.nested.a, 1, "should preserve nested.a");
  assertEquals(final.nested.b, 99, "should update nested.b");
  assertEquals(final.nested.c, 3, "should add nested.c");
  assertEquals(final.list, [1, 2], "should leave list unchanged");
});

Deno.test("mergeUpdate: replaces arrays wholesale", async () => {
  const entity = makeFakeEntity({ id: "test", list: [1, 2, 3] });
  await mergeUpdate(entity, "test", { list: [9, 8] });
  const final = entity._peek();
  assertEquals(final.list, [9, 8]);
});

Deno.test("mergeUpdate: verify-write success when patch lands cleanly", async () => {
  const entity = makeFakeEntity({ id: "test", status: "Submitted" });
  const result = await mergeUpdate(
    entity,
    "test",
    { status: "Filed" },
    { verifyWrite: true, retryDelayMs: 5 },
  );
  assertEquals(result.success, true);
  assertEquals(entity._peek().status, "Filed");
});

Deno.test("mergeUpdate: verify-write detects silent discard", async () => {
  const entity = makeFakeEntity({ id: "test", status: "Submitted" });
  // Simulate URGENT 15: every update returns 200 but storage doesn't actually change
  entity._setUpdateBehavior(async () => {});

  const result = await mergeUpdate(
    entity,
    "test",
    { status: "Filed" },
    { verifyWrite: true, maxRetries: 2, retryDelayMs: 5 },
  );
  assertEquals(result.success, false);
  assertEquals(result.failureReason, "silent_discard");
  assertExists(result.divergedFields);
  assert(result.divergedFields!.includes("status"));
});

Deno.test("mergeUpdate: returns read_failed when initial get throws", async () => {
  const brokenEntity = {
    get: async () => {
      throw new Error("simulated read failure");
    },
    update: async () => {},
  };
  const result = await mergeUpdate(brokenEntity as any, "test", { x: 1 });
  assertEquals(result.success, false);
  assertEquals(result.failureReason, "read_failed");
});

Deno.test("mergeUpdate: returns write_failed when update throws", async () => {
  const entity = makeFakeEntity({ id: "test", status: "Submitted" });
  entity._setUpdateBehavior(async () => {
    throw new Error("simulated write failure");
  });
  const result = await mergeUpdate(entity, "test", { status: "Filed" });
  assertEquals(result.success, false);
  assertEquals(result.failureReason, "write_failed");
});

// =============================================================================
// audit tests
// =============================================================================

Deno.test("audit: writes inline when before+after fits within size budget", async () => {
  const fb = makeFakeBase44();
  const result = await audit(fb.client, {
    actor_email: "clifford@azclaimsco.com",
    action_type: "claim_status_changed",
    target_entity: "Claim",
    target_id: "claim_123",
    before: { status: "Submitted" },
    after: { status: "Filed" },
  });
  assertExists(result.id);
  assertEquals(result.externalized, false);

  const rows = fb._getAuditLogRows();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].actor_email, "clifford@azclaimsco.com");
  assertEquals(rows[0].action_type, "claim_status_changed");
  assertExists(rows[0].before_summary);
  assertExists(rows[0].after_summary);
  assertEquals(rows[0].before_full_url, null);
  assertEquals(rows[0].after_full_url, null);

  // No CDN uploads should have occurred
  assertEquals(fb._getUploadedFiles().length, 0);
});

Deno.test("audit: externalizes large payloads to CDN", async () => {
  const fb = makeFakeBase44();
  // Build a before-state with ~16KB of nested data to trigger externalization
  const largeBefore = {
    activity_log: Array.from({ length: 500 }, (_, i) => ({
      action: "log_entry",
      at: "2026-04-27T00:00:00Z",
      note: `Entry ${i} with some descriptive text to fill bytes`,
    })),
  };

  const result = await audit(fb.client, {
    actor_email: "clifford@azclaimsco.com",
    action_type: "claim_archived",
    target_entity: "Claim",
    target_id: "claim_456",
    before: largeBefore,
    after: null,
  });
  assertExists(result.id);
  assertEquals(result.externalized, true);

  const rows = fb._getAuditLogRows();
  assertEquals(rows.length, 1);
  // Either before_full_url or after_full_url should be set; before is the large one
  assertExists(rows[0].before_full_url);
  // before_summary should be the truncation marker, not the full string
  assert(
    rows[0].before_summary && rows[0].before_summary.length < 16_000,
    "before_summary should be truncated",
  );

  const uploads = fb._getUploadedFiles();
  assertEquals(uploads.length, 1, "exactly one file uploaded for the large before");
  assert(uploads[0].name.includes("before"));
});

Deno.test("audit: requires actor_email", async () => {
  const fb = makeFakeBase44();
  await assertRejects(
    () =>
      audit(fb.client, {
        actor_email: "",
        action_type: "x",
        target_entity: "Claim",
        target_id: "id",
        before: {},
        after: {},
      } as any),
    Error,
    "actor_email",
  );
});

Deno.test("audit: handles null before/after correctly", async () => {
  const fb = makeFakeBase44();
  await audit(fb.client, {
    actor_email: "clifford@azclaimsco.com",
    action_type: "claim_created",
    target_entity: "Claim",
    target_id: "claim_789",
    before: null,
    after: { status: "Submitted" },
  });
  const rows = fb._getAuditLogRows();
  assertEquals(rows[0].before_summary, null);
  assertExists(rows[0].after_summary);
});

// =============================================================================
// appendArrayField tests
// =============================================================================

Deno.test("appendArrayField: appends entries to existing array", async () => {
  const entity = makeFakeEntity({
    id: "test",
    activity_log: [
      { action: "created", at: "2026-04-26T00:00:00Z" },
    ],
  });
  const result = await appendArrayField(entity, "test", "activity_log", [
    { action: "filed", at: "2026-04-27T00:00:00Z" },
  ], { retryDelayMs: 5 });
  assertEquals(result.success, true);
  assertEquals(result.finalLength, 2);
  assertEquals(result.rejectedEntries.length, 0);
  const final = entity._peek();
  assertEquals(final.activity_log.length, 2);
  assertEquals(final.activity_log[1].action, "filed");
});

Deno.test("appendArrayField: rejects entries with oversized strings", async () => {
  const entity = makeFakeEntity({ id: "test", activity_log: [] });
  const oversizedString = "x".repeat(25_000); // exceeds default 20000
  const result = await appendArrayField(
    entity,
    "test",
    "activity_log",
    [
      { action: "ok", note: "small note" },
      { action: "too_big", note: oversizedString },
      { action: "also_ok", note: "small" },
    ],
    { retryDelayMs: 5 },
  );
  assertEquals(result.success, true);
  assertEquals(result.finalLength, 2, "two accepted entries appended");
  assertEquals(result.rejectedEntries.length, 1, "one entry rejected");
  assertEquals((result.rejectedEntries[0] as any).action, "too_big");
});

Deno.test("appendArrayField: throws if field is not an array", async () => {
  const entity = makeFakeEntity({ id: "test", not_an_array: "string value" });
  await assertRejects(
    () =>
      appendArrayField(entity, "test", "not_an_array", [{ x: 1 }] as any[], {
        retryDelayMs: 5,
      }),
    Error,
    "not an array",
  );
});

Deno.test("appendArrayField: empty newEntries is a no-op success", async () => {
  const entity = makeFakeEntity({ id: "test", list: [1, 2, 3] });
  entity._resetCallCount();
  const result = await appendArrayField(entity, "test", "list", [], {
    retryDelayMs: 5,
  });
  assertEquals(result.success, true);
  assertEquals(result.finalLength, 3);
  assertEquals(entity._getUpdateCallCount(), 0, "no write on empty append");
});

Deno.test("appendArrayField: tolerates concurrent appender (length grew unexpectedly)", async () => {
  const entity = makeFakeEntity({ id: "test", activity_log: [{ a: 1 }] });
  // Simulate URGENT 15-style scenario: another writer adds an entry between
  // our get() and our verify-read. Our intent: append 1 entry (expected length 2).
  // After our write, verify-read shows length 3 (concurrent writer added another).
  let writeCount = 0;
  entity._setUpdateBehavior(async (_id, value) => {
    writeCount++;
    // First write applies normally
    if (writeCount === 1) {
      // Inject a phantom concurrent writer's entry, then apply our patch
      const enriched = { ...value };
      enriched.activity_log = [...value.activity_log, { phantom: true }];
      entity._setStorage(enriched);
    } else {
      entity._setStorage(value);
    }
  });
  const result = await appendArrayField(
    entity,
    "test",
    "activity_log",
    [{ a: 2 }],
    { verifyWrite: true, retryDelayMs: 5 },
  );
  // Should treat actualLength >= expectedLength as success (concurrent writer's
  // entries are present alongside ours; tolerant by design)
  assertEquals(result.success, true);
});

Deno.test("appendArrayField: verify-write detects silent discard", async () => {
  const entity = makeFakeEntity({
    id: "test",
    activity_log: [{ existing: true }],
  });
  // Simulate URGENT 15 silent discard: every update is a no-op
  entity._setUpdateBehavior(async () => {});

  const result = await appendArrayField(
    entity,
    "test",
    "activity_log",
    [{ new: true }],
    { verifyWrite: true, maxRetries: 2, retryDelayMs: 5 },
  );
  assertEquals(result.success, false);
  assertEquals(result.failureReason, "silent_discard");
});
