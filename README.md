# claimsco-utils

Foundational utilities for the ClaimsCo platform. Imported via SHA-pinned URL into Base44 server functions.

This repo exists because Base44 server functions run in sandboxed Deno isolates with no relative cross-function imports. To share code across functions without copy-paste duplication, we publish utilities here and import via raw GitHub URLs pinned to specific commit SHAs.

## Structure
/src/                       Utility source files (Deno-compatible TypeScript)
mergeUpdate.ts            Deep-merge wrapper for Entity.update with optional verify-write
withRetry.ts              Exponential-backoff retry with jitter and deadline awareness
audit.ts                  AuditLog entity write helper with verify-write
idempotencyGuard.ts       Skip-if-already-processed pattern for handlers
anthropic-client.ts       Singleton wrapping npm:@anthropic-ai/sdk with cache + retry + usage logging
(added in Sub-phase D)
/tests/                     Unit tests (deno test runnable)
/docs/
utility-reference.md      Canonical signature/behavior/blessed-SHA reference
/scripts/
(no scripts here — see main app repo for validate-imports.sh)

Each utility is self-contained — no relative imports between files in this repo. Cross-utility composition happens at the consuming function level.

## Import pattern

From a Base44 function, import via SHA-pinned raw URL:

```typescript
import { mergeUpdate } from "https://raw.githubusercontent.com/ClaimsCo/claimsco-utils/abc123def4567890abc123def4567890abc12345/src/mergeUpdate.ts";
```

The 40-character hex string between `claimsco-utils/` and `/src/` is the commit SHA. **It must be a full 40-char SHA. Branch refs (`main`, `master`) and short SHAs are rejected by the pre-deployment validation script.**

## SHA-pinning policy

**Why SHA-pinning, not branches:**
- Branch refs are mutable. A `main` ref today and `main` ref tomorrow can resolve to different code, silently changing function behavior between deploys.
- Full 40-char SHAs are immutable. Once a function is deployed importing from a specific SHA, that import is byte-for-byte stable until the function itself is redeployed.
- This converts "what version of the utility is in production?" from an ambiguous question to a grep against deployed function source.

**Why public repo:**
- Deno's URL imports do not authenticate. Public repo means imports work without token configuration in Base44 functions.
- The utility code is not commercially sensitive. The schemas it operates on (Claim, Interaction, etc.) are.

## Contribution / utility-update workflow

To update a utility:

1. **Edit** the utility source in this repo on a feature branch.
2. **Test** locally with `deno test` against the test files in `/tests/`.
3. **PR + merge** to main. The merge commit SHA is the candidate new blessed SHA.
4. **Update** `docs/utility-reference.md` with the new SHA and date.
5. **Deploy** consuming Base44 functions one at a time, updating their import URL to the new SHA. Run `validate-imports.sh` (in the main app repo) before each deploy.
6. **Audit** the function execution log after deploy to confirm the new utility version executes as expected.

**Rollback:** if a new SHA causes a regression, revert consuming functions one at a time to the previous blessed SHA. The previous SHA is still immutably accessible via the same raw URL pattern.

## Versioning

This repo does not use semantic version tags. The blessed SHA in `docs/utility-reference.md` IS the version. Tags would be redundant and create the illusion of a public release cadence we do not have.

## License

Internal use only. Not licensed for external consumption.
