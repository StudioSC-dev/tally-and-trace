#!/usr/bin/env bash
# STU-643: sharedLimitTargets (its only caller is frontend/src/routes/accounts.tsx) type-checks
# and its unit tests pass. Run from anywhere; needs `pnpm install` done.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$root/packages/shared" && npx tsc --noEmit)
(cd "$root/frontend" && npx tsc --noEmit)
(cd "$root/packages/shared" && TZ=Asia/Manila npx vitest run src/utils/cardCredit.test.ts)
echo "shared_limit_targets_callers_and_regressions: OK"
