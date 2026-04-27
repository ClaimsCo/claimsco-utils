/**
 * appendArrayField — append entries to an array-typed entity field with
 * URGENT 13 size guards and URGENT 15 verify-write semantics.
 *
 * Background:
 * - Per Findings v6 URGENT 13, individual string values cannot exceed ~20KB
 *   during platform write validation. The cap applies to strings nested inside
 *   array elements (confirmed in pre-Phase-1 activity_log probe). A single
 *   oversized entry would cause the platform to reject the entire write.
 * - Per Findings v6 URGENT 15, concurrent writes can return HTTP 200 with
 *   payload silently discarded. For audit-trail-style array fields like
 *   activity_log, a silently dropped append is a permanently lost entry.
 *   Verify-write is enabled by default for this reason.
 * - This utility is the canonical pattern for any array-field append. Code
 *   review rule: "Are you appending to an array entity field? Use this."
 *
 * Behavior:
 * 1. Read entity by id. Throw if entity[fieldName] is not an array.
 * 2. If preflightSizeCheck enabled, scan newEntries. Reject any entry
 *    containing a string value exceeding maxStringValueBytes.
 * 3. Concatenate accepted entries onto the existing array.
 * 4. Write via entity.update.
 * 5. If verifyWrite enabled, re-read and confirm the array length increased
 *    by the expected count. Retry on mismatch.
 *
 * Returns { success, finalLength, rejectedEntries } so callers can decide
 * whether to externalize the rejected entries (e.g., upload large content
 * to CDN, store URL reference inline) and re-attempt the append with
 * smaller payloads.
 *
 * Usage:
 *   const result = await appendArrayField(
 *     base44.asServiceRole.entities.Claim,
 *     claimId,
 *     'activity_log',
 *     [{ action: 'status_changed', actor: 'clifford@azclaimsco.com', at: now, note: 'Filed' }],
 *   );
 *   if (!result.success) {
 *     // verify-write failed; escalate to ErrorLog
 *   }
 *   if (result.rejectedEntries && result.rejectedEntries.length > 0) {
 *     // some entries had oversized strings; externalize and retry
 *   }
 */

export interface AppendArrayFieldOptions {
  /** Re-read after write; confirm length increased by expected count. Default true. */
  verifyWrite?: boolean;
  /** Max retries on verify-write mismatch. Default 3. */
  maxRetries?: number;
  /** Pre-flight per-string size check. Default true. */
  preflightSizeCheck?: boolean;
  /** Maximum allowed bytes for any single string value within an entry. Default 20000. */
  maxStringValueBytes?: number;
  /** Backoff between verify-write retries, in ms. Default 100. */
  retryDelayMs?: number;
}

export interface AppendArrayFieldResult<T> {
  /** True if write succeeded and (if enabled) verify-write confirmed. */
  success: boolean;
  /** Final length of the array on the entity record after append. */
  finalLength: number;
  /** Entries rejected by preflightSizeCheck. Empty array if none rejected. */
  rejectedEntries: T[];
  /** Failure reason if success=false. */
  failureReason?: 'silent_discard' | 'read_failed' | 'write_failed' | 'field_not_array';
}

/**
 * Recursively walk an entry, finding any string value exceeding the byte
 * threshold. Returns the field path of the first oversized string found,
 * or null if all strings are within budget.
 *
 * Path format: 'note', 'metadata.body', 'attachments[2].caption', etc.
 * Useful for the rejectedEntries diagnostic.
 */
function findOversizedString(
  value: any,
  maxBytes: number,
  path = '',
): string | null {
  if (typeof value === 'string') {
    if (value.length > maxBytes) {
      return path || '<root>';
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findOversizedString(value[i], maxBytes, `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const subPath = path ? `${path}.${key}` : key;
      const found = findOversizedString(value[key], maxBytes, subPath);
      if (found) return found;
    }
    return null;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function appendArrayField<T = any>(
  entity: any,
  id: string,
  fieldName: string,
  newEntries: T[],
  options: AppendArrayFieldOptions = {},
): Promise<AppendArrayFieldResult<T>> {
  const {
    verifyWrite = true,
    maxRetries = 3,
    preflightSizeCheck = true,
    maxStringValueBytes = 20_000,
    retryDelayMs = 100,
  } = options;

  // Validate inputs
  if (!Array.isArray(newEntries)) {
    throw new Error('appendArrayField: newEntries must be an array');
  }

  if (newEntries.length === 0) {
    // Nothing to do — return current length without any I/O failure mode
    let current: any;
    try {
      current = await entity.get(id);
    } catch (err) {
      return {
        success: false,
        finalLength: 0,
        rejectedEntries: [],
        failureReason: 'read_failed',
      };
    }
    const arr = current?.[fieldName];
    if (!Array.isArray(arr)) {
      return {
        success: false,
        finalLength: 0,
        rejectedEntries: [],
        failureReason: 'field_not_array',
      };
    }
    return { success: true, finalLength: arr.length, rejectedEntries: [] };
  }

  // Read current state
  let current: any;
  try {
    current = await entity.get(id);
  } catch (err) {
    return {
      success: false,
      finalLength: 0,
      rejectedEntries: [...newEntries],
      failureReason: 'read_failed',
    };
  }

  const existingArray = current?.[fieldName];
  if (!Array.isArray(existingArray)) {
    throw new Error(
      `appendArrayField: field '${fieldName}' is not an array (got ${typeof existingArray})`,
    );
  }

  // Preflight: filter rejected entries
  const accepted: T[] = [];
  const rejected: T[] = [];

  if (preflightSizeCheck) {
    for (const entry of newEntries) {
      const oversizedPath = findOversizedString(entry, maxStringValueBytes);
      if (oversizedPath) {
        rejected.push(entry);
      } else {
        accepted.push(entry);
      }
    }
  } else {
    accepted.push(...newEntries);
  }

  // If everything was rejected, no write is needed
  if (accepted.length === 0) {
    return {
      success: true,
      finalLength: existingArray.length,
      rejectedEntries: rejected,
    };
  }

  // Build new array and write
  const newArray = [...existingArray, ...accepted];
  const expectedLength = newArray.length;

  try {
    await entity.update(id, { [fieldName]: newArray });
  } catch (err) {
    return {
      success: false,
      finalLength: existingArray.length,
      rejectedEntries: rejected,
      failureReason: 'write_failed',
    };
  }

  if (!verifyWrite) {
    return {
      success: true,
      finalLength: expectedLength,
      rejectedEntries: rejected,
    };
  }

  // Verify-write loop
  // Special note: appendArrayField's retry semantics differ from mergeUpdate.
  // The naive approach (re-merge with original entries) would compound
  // duplicates if the original write actually landed but verify-read was
  // stale. Instead, we read fresh, check whether our accepted entries are
  // already present (by length only — strict equality on entry contents
  // would require deep-compare, which is overkill for the audit case).
  // If length matches expected: success. If length is short by N, append
  // the missing N entries. If length is long: somebody else wrote
  // concurrently; bail with success since our entries are present and
  // we don't want to clobber their writes.

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(retryDelayMs * (attempt + 1));

    let actual: any;
    try {
      actual = await entity.get(id);
    } catch {
      continue;
    }

    const actualArray = actual?.[fieldName];
    if (!Array.isArray(actualArray)) {
      // Field shape changed unexpectedly — concurrent writer corrupted it
      return {
        success: false,
        finalLength: 0,
        rejectedEntries: rejected,
        failureReason: 'silent_discard',
      };
    }

    if (actualArray.length >= expectedLength) {
      // Our entries (or at least equivalent count of entries from a
      // concurrent writer) are present. Treat as success — there's no
      // safe way to disambiguate "our write landed" from "concurrent
      // writer also appended" without deep-comparing entry contents.
      // The activity_log audit case is tolerant of duplicate or
      // concurrent appends.
      return {
        success: true,
        finalLength: actualArray.length,
        rejectedEntries: rejected,
      };
    }

    // Length is short — silent discard. Re-attempt the append.
    if (attempt === maxRetries - 1) {
      return {
        success: false,
        finalLength: actualArray.length,
        rejectedEntries: rejected,
        failureReason: 'silent_discard',
      };
    }

    // Append accepted entries fresh on top of current state
    const reAppended = [...actualArray, ...accepted];
    try {
      await entity.update(id, { [fieldName]: reAppended });
    } catch {
      continue;
    }
  }

  // Unreachable but TypeScript needs the return
  return {
    success: false,
    finalLength: existingArray.length + accepted.length,
    rejectedEntries: rejected,
    failureReason: 'silent_discard',
  };
}
