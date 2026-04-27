/**
 * mergeUpdate — deep-merge wrapper for Base44 Entity.update with optional verify-write.
 *
 * Background:
 * - Per Findings v6 URGENT 3, Base44's Entity.update is a shallow overwrite at the
 *   top level. Nested objects in the patch replace the entire nested object on the
 *   stored record; nested keys outside the patch are lost.
 * - Per Findings v6 URGENT 15, concurrent writes to the same record can return
 *   HTTP 200 while the payload is silently discarded. This utility's optional
 *   verify-write mode catches that.
 * - Per Findings v6 URGENT 13, individual string values in writes are capped at
 *   ~20KB. This utility does NOT enforce that cap (the platform does, with a clear
 *   error). Callers writing large content split or externalize before calling.
 *
 * Default behavior: read current state, deep-merge patch, write merged result.
 *
 * Verify-write behavior (verifyWrite: true): after the write, re-read the record
 * and confirm the patched fields reflect the patched values. On mismatch, retry
 * up to maxRetries times. By default, retries re-read fresh state and re-merge
 * the patch on top of it (handles concurrent writes from other writers correctly).
 *
 * Returns { success, finalState }. On verify-write final mismatch, success is
 * false and the caller is expected to escalate (e.g., write
 * error_type: 'silent_discard' to ErrorLog).
 *
 * Note: arrays are replaced wholesale, not appended. For appending to array
 * fields (e.g., activity_log), use appendArrayField from this same repo.
 */

export interface MergeUpdateOptions {
  /** Re-read after write and confirm patched fields match. Default false. */
  verifyWrite?: boolean;
  /** Max retries on verify-write mismatch. Default 3. */
  maxRetries?: number;
  /** On retry, re-read fresh state and re-merge patch. Default true. */
  reMergeOnRetry?: boolean;
  /** Compare entire entity (true) vs only patched fields (false). Default false. */
  strictCompare?: boolean;
  /** Backoff between verify-write retries, in ms. Default 100. */
  retryDelayMs?: number;
}

export interface MergeUpdateResult<T> {
  success: boolean;
  finalState: T;
  /** Populated if success=false; describes the failure mode for logging. */
  failureReason?: 'silent_discard' | 'read_failed' | 'write_failed';
  /** On silent_discard, the field paths that did not reflect the patch. */
  divergedFields?: string[];
}

/**
 * Recursive deep-merge. Plain objects merge field-by-field; arrays and primitives
 * are replaced wholesale (callers wanting array append should use appendArrayField).
 *
 * "Plain object" means: not null, typeof === 'object', not Array, not Date,
 * constructor is Object (or no constructor). Non-plain objects (e.g., Date,
 * RegExp, custom class instances) are replaced wholesale, not merged.
 */
function deepMerge<T>(target: any, source: any): T {
  if (source === null || source === undefined) return target as T;
  if (!isPlainObject(target) || !isPlainObject(source)) return source as T;

  const result: Record<string, any> = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

function isPlainObject(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (value instanceof RegExp) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Compare actual post-write state against expected. Returns array of diverged
 * field paths, empty if all match. With strictCompare, walks the entire entity;
 * otherwise walks only the patched paths.
 */
function findDivergence(
  expected: any,
  actual: any,
  patch: any,
  strict: boolean,
  pathPrefix = '',
): string[] {
  const diverged: string[] = [];

  const fieldsToCheck = strict ? Object.keys(expected) : Object.keys(patch);

  for (const key of fieldsToCheck) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const expectedVal = expected[key];
    const actualVal = actual?.[key];
    const patchVal = patch?.[key];

    if (isPlainObject(expectedVal) && isPlainObject(actualVal)) {
      // Recurse into nested objects, narrowing the patch view too
      const nestedPatch = isPlainObject(patchVal) ? patchVal : expectedVal;
      diverged.push(...findDivergence(expectedVal, actualVal, nestedPatch, strict, path));
    } else if (!valueEqual(expectedVal, actualVal)) {
      diverged.push(path);
    }
  }

  return diverged;
}

function valueEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valueEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!valueEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mergeUpdate<T = any>(
  entity: any,
  id: string,
  patch: Partial<T>,
  options: MergeUpdateOptions = {},
): Promise<MergeUpdateResult<T>> {
  const {
    verifyWrite = false,
    maxRetries = 3,
    reMergeOnRetry = true,
    strictCompare = false,
    retryDelayMs = 100,
  } = options;

  // Initial read
  let current: T;
  try {
    current = await entity.get(id);
  } catch (err) {
    return {
      success: false,
      finalState: null as unknown as T,
      failureReason: 'read_failed',
    };
  }

  // Initial merge + write
  let merged = deepMerge<T>(current, patch);
  try {
    await entity.update(id, merged);
  } catch (err) {
    return { success: false, finalState: merged, failureReason: 'write_failed' };
  }

  if (!verifyWrite) {
    return { success: true, finalState: merged };
  }

  // Verify-write loop
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(retryDelayMs);
    let actual: any;
    try {
      actual = await entity.get(id);
    } catch (err) {
      // Read failed during verify; try again on next iteration
      continue;
    }

    const diverged = findDivergence(merged, actual, patch, strictCompare);
    if (diverged.length === 0) {
      return { success: true, finalState: actual };
    }

    // Mismatch: retry
    if (attempt === maxRetries - 1) {
      return {
        success: false,
        finalState: actual,
        failureReason: 'silent_discard',
        divergedFields: diverged,
      };
    }

    if (reMergeOnRetry) {
      // Re-merge patch on top of fresh actual state, then re-write
      merged = deepMerge<T>(actual, patch);
    }
    try {
      await entity.update(id, merged);
    } catch (err) {
      // Write failed during retry; treat as silent_discard for next pass
      continue;
    }
  }

  // Should be unreachable, but TypeScript wants a final return
  return { success: false, finalState: merged, failureReason: 'silent_discard' };
}
