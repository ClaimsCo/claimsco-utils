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
