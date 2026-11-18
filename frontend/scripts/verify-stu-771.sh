#!/usr/bin/env bash
# STU-771 verification suite: the named checks for "e2e pages load from a built bundle". Separate from
# `pnpm test:e2e`, which it invokes but is not part of.
#
#   scripts/verify-stu-771.sh [scenario ...]      run from anywhere; no argument runs every scenario
#
# Scenarios: ac1 ("e2e serves a built bundle"), ac2 ("three consecutive local e2e runs pass cleanly"),
# ac3 ("built bundle reduces Dashboard load median"), ac4 ("PR head e2e passes in CI"),
# ac5 ("preview compatibility edits match the PR record"), ac6 ("preview migration preserves suite configuration").
#
# Environment:
#   E2E_PORT          the port every server here uses (default 4317, as in playwright.config.ts)
#   STU771_BASE       the revision the PR is measured against (default origin/main)
#   STU771_PR_BODY    the PR description AC5 reads (default <repo>/.pr-body.md)
#   STU771_WORK       where logs, reports and the base worktree go (default a new temporary directory)
#   GH_TOKEN          for ac4 only, if `gh` is not otherwise signed in
#
# ac2 runs the full suite three times and takes about as long. ac3 checks out STU771_BASE as a git worktree under
# STU771_WORK, with this checkout's frontend node_modules linked in, and removes it afterwards.
set -u -o pipefail

FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(git -C "$FRONTEND" rev-parse --show-toplevel)" || exit 2
PORT="${E2E_PORT:-4317}"
BASE_REF="${STU771_BASE:-origin/main}"
PR_BODY="${STU771_PR_BODY:-$REPO/.pr-body.md}"
WORK="${STU771_WORK:-$(mktemp -d)}"
mkdir -p "$WORK" || exit 2
LIB="$FRONTEND/scripts/stu-771/lib.mjs"
PW="$FRONTEND/node_modules/.bin/playwright"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
BASE_SHA="$(git -C "$REPO" rev-parse "$BASE_REF")" || exit 2
BASE_TREE="$WORK/base"
export E2E_PORT="$PORT"

FAILED=()
log() { printf '%s\n' "$*"; }
pass() { log "PASS  $1"; }
flunk() {
  log "FAIL  $1: $2"
  FAILED+=("$1")
}
load() { cut -d' ' -f1-3 /proc/loadavg; }
port_open() { curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/"; }

# The base revision as a worktree, with this checkout's frontend node_modules linked in (no install).
base_tree() {
  if [ ! -d "$BASE_TREE" ]; then
    git -C "$REPO" worktree add --detach --quiet "$BASE_TREE" "$BASE_SHA" || return 1
    ln -s "$FRONTEND/node_modules" "$BASE_TREE/frontend/node_modules" || return 1
  fi
}
cleanup() {
  if [ -d "$BASE_TREE" ]; then
    rm -f "$BASE_TREE/frontend/node_modules"
    git -C "$REPO" worktree remove --force "$BASE_TREE"
  fi
}
trap cleanup EXIT

log "STU-771 verification: head $HEAD_SHA, base $BASE_REF $BASE_SHA, host $(hostname), E2E_PORT $PORT, work $WORK"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  log "the working tree has uncommitted changes, so results would not be the PR head's; commit or stash them first"
  exit 2
fi
if port_open; then
  log "E2E_PORT $PORT is already serving; free it or pick another E2E_PORT"
  exit 2
fi

# AC1: the webServer builds once, then serves the build with vite preview on E2E_PORT; a failed build or an
# occupied port stops startup.
scenario_ac1() {
  local name='e2e serves a built bundle' out="$WORK/ac1" code
  mkdir -p "$out"

  # (a) The command, as Playwright resolves it.
  local command
  command="$(cd "$FRONTEND" && node --input-type=module -e "const c = (await import('./playwright.config.ts')).default; process.stdout.write(c.webServer.command)")"
  log "  webServer.command: $command"
  local outdir="node_modules/.e2e-dist/$PORT"
  if [[ "$command" != "pnpm exec vite build --minify false --outDir $outdir && pnpm exec vite preview --outDir $outdir --port $PORT --strictPort" ]]; then
    flunk "$name" "webServer.command is not 'vite build --minify false --outDir $outdir && vite preview --outDir $outdir --port $PORT --strictPort'"
    return
  fi

  # (b) A successful build runs once into the run's own directory, before preview listens on E2E_PORT; no dev server
  # starts, and the shared dist/ is left as it was.
  local dist_before dist_after
  dist_before="$(cd "$FRONTEND" && find dist -printf '%p %T@ %s\n' 2>/dev/null | sort | sha256sum)"
  (cd "$FRONTEND" && DEBUG=pw:webserver "$PW" test e2e/manifest.spec.ts --project=desktop --reporter=line \
    --output "$out/ok-results") >"$out/ok.log" 2>&1
  code=$?
  local builds ready_line build_line dev_lines
  builds="$(grep -c 'built in' "$out/ok.log")"
  build_line="$(grep -n 'built in' "$out/ok.log" | head -1 | cut -d: -f1)"
  ready_line="$(grep -n "Local: *http://localhost:$PORT/" "$out/ok.log" | head -1 | cut -d: -f1)"
  dev_lines="$(grep -c 'ready in' "$out/ok.log")"
  dist_after="$(cd "$FRONTEND" && find dist -printf '%p %T@ %s\n' 2>/dev/null | sort | sha256sum)"
  log "  build+preview run: exit $code, builds $builds, build line ${build_line:-none}, preview line ${ready_line:-none}, dev-server ready lines $dev_lines, $outdir/index.html: $([ -f "$FRONTEND/$outdir/index.html" ] && echo present || echo missing), dist/ unchanged: $([ "$dist_before" = "$dist_after" ] && echo yes || echo no)"
  if [ "$code" -ne 0 ] || [ "$builds" -ne 1 ] || [ -z "$ready_line" ] || [ "$build_line" -ge "$ready_line" ] || [ "$dev_lines" -ne 0 ] \
    || [ ! -f "$FRONTEND/$outdir/index.html" ] || [ "$dist_before" != "$dist_after" ]; then
    flunk "$name" "the successful start did not build once and then preview on $PORT (see $out/ok.log)"
    return
  fi

  # (c) A failed build stops preview from starting: a copy of the frontend with a syntax error in src/main.tsx.
  local broken="$WORK/broken-frontend"
  rm -rf "$broken"
  rsync -a --exclude node_modules --exclude dist --exclude test-results "$FRONTEND/" "$broken/" || return
  ln -s "$FRONTEND/node_modules" "$broken/node_modules"
  printf '\nexport const stu771BrokenBuild = ;\n' >>"$broken/src/main.tsx"
  : >"$out/port-probe.log"
  # The copy's node_modules is this checkout's, so its build would land in the same run directory: it must not change.
  local stamp_before stamp_after
  stamp_before="$(stat -c %Y.%s "$FRONTEND/$outdir/index.html" 2>/dev/null)"
  (for _ in $(seq 1 600); do port_open && echo "open $(date +%s)" >>"$out/port-probe.log"; sleep 0.2; done) &
  local prober=$!
  (cd "$broken" && DEBUG=pw:webserver "$PW" test e2e/manifest.spec.ts --project=desktop --reporter=line \
    --output "$out/broken-results") >"$out/broken.log" 2>&1
  code=$?
  kill "$prober" 2>/dev/null
  wait "$prober" 2>/dev/null
  rm -f "$broken/node_modules"
  stamp_after="$(stat -c %Y.%s "$FRONTEND/$outdir/index.html" 2>/dev/null)"
  local preview_lines opened
  preview_lines="$(grep -c "Local: *http://localhost" "$out/broken.log")"
  opened="$(wc -l <"$out/port-probe.log")"
  log "  broken build run: exit $code, preview lines $preview_lines, port seen open $opened times, build output written: $([ -e "$broken/dist/index.html" ] || [ "$stamp_before" != "$stamp_after" ] && echo yes || echo no)"
  if [ "$code" -eq 0 ] || ! grep -q 'Build failed\|error during build' "$out/broken.log" || [ "$preview_lines" -ne 0 ] \
    || [ "$opened" -ne 0 ] || ! grep -q 'config.webServer' "$out/broken.log" || [ -e "$broken/dist/index.html" ] \
    || [ "$stamp_before" != "$stamp_after" ]; then
    flunk "$name" "a failed build did not stop startup before preview (see $out/broken.log)"
    return
  fi
  rm -rf "$broken"

  # (d) An occupied E2E_PORT fails startup: Playwright does not attach to the other server, and preview does not
  # move to another port.
  : >"$out/decoy-requests.log"
  node -e '
    const http = require("node:http"); const fs = require("node:fs")
    const [port, logFile] = process.argv.slice(1)
    for (const host of ["127.0.0.1", "::1"]) {
      http.createServer((req, res) => { fs.appendFileSync(logFile, req.method + " " + req.url + "\n"); res.end("decoy") })
        .listen(Number(port), host).on("error", () => {})
    }' "$PORT" "$out/decoy-requests.log" &
  local decoy=$!
  for _ in $(seq 1 50); do port_open && break; sleep 0.1; done
  : >"$out/decoy-requests.log"
  (cd "$FRONTEND" && DEBUG=pw:webserver "$PW" test e2e/manifest.spec.ts --project=desktop --reporter=line \
    --output "$out/busy-results") >"$out/busy.log" 2>&1
  code=$?
  local strict_code
  (cd "$FRONTEND" && timeout 60 pnpm exec vite preview --outDir "$outdir" --port "$PORT" --strictPort) >"$out/busy-preview.log" 2>&1
  strict_code=$?
  kill "$decoy" 2>/dev/null
  wait "$decoy" 2>/dev/null
  local other_requests
  other_requests="$(grep -vc '^GET / *$' "$out/decoy-requests.log")"
  log "  occupied port: playwright exit $code, builds $(grep -c 'built in' "$out/busy.log"), decoy requests other than GET / $other_requests; vite preview --strictPort exit $strict_code"
  if [ "$code" -eq 0 ] || ! grep -q "is already used" "$out/busy.log" || grep -q 'built in' "$out/busy.log" \
    || [ "$other_requests" -ne 0 ] || grep -q 'passed' "$out/busy.log"; then
    flunk "$name" "Playwright did not refuse the occupied port (see $out/busy.log, $out/decoy-requests.log)"
    return
  fi
  if [ "$strict_code" -eq 0 ] || [ "$strict_code" -eq 124 ] || ! grep -q "Port $PORT is already in use" "$out/busy-preview.log" \
    || grep -q 'Local:' "$out/busy-preview.log"; then
    flunk "$name" "vite preview --strictPort did not refuse the occupied port (see $out/busy-preview.log)"
    return
  fi
  pass "$name"
}

# AC2: the full pnpm test:e2e three times in a row with --workers=3, zero failures and zero flaky tests.
scenario_ac2() {
  local name='three consecutive local e2e runs pass cleanly' out="$WORK/ac2" run code stats start_load end_load
  mkdir -p "$out"
  for run in 1 2 3; do
    start_load="$(load)"
    log "  run $run: host $(hostname), start $(date -Is), load $start_load"
    (cd "$FRONTEND" && pnpm --silent test:e2e --workers=3) >"$out/run$run.log" 2>&1
    code=$?
    end_load="$(load)"
    cp "$FRONTEND/test-results/report.json" "$out/run$run.json" 2>/dev/null
    stats="$(node "$LIB" report-stats "$out/run$run.json" 2>&1)"
    log "  run $run: end $(date -Is), load $end_load, exit $code, $stats"
    if [ "$code" -ne 0 ] || ! node -e 'const s = JSON.parse(process.argv[1]); process.exit(s.unexpected === 0 && s.flaky === 0 && s.errors === 0 && s.expected > 0 ? 0 : 1)' "$stats"; then
      flunk "$name" "run $run had failures, flaky tests or errors (see $out/run$run.log)"
      return
    fi
  done
  pass "$name"
}

# AC3: the Dashboard's median load, 20 loads with 3 workers on each revision, is lower on the PR head.
scenario_ac3() {
  local name='built bundle reduces Dashboard load median' out="$WORK/ac3"
  mkdir -p "$out"
  # Same test data: the shared fixtures and the shared package are identical on both revisions.
  if ! git -C "$REPO" diff --quiet "$BASE_SHA" HEAD -- frontend/e2e/support packages/shared; then
    flunk "$name" "the e2e fixtures or the shared package differ between $BASE_REF and HEAD, so the data would not match"
    return
  fi
  base_tree || { flunk "$name" "could not check out $BASE_REF"; return; }
  mkdir -p "$BASE_TREE/frontend/scripts/stu-771"
  cp "$FRONTEND/scripts/stu-771/measure.config.ts" "$FRONTEND/scripts/stu-771/dashboard-load.measure.ts" "$BASE_TREE/frontend/scripts/stu-771/"
  local rev dir sha code median count
  declare -A medians
  for rev in base head; do
    if [ "$rev" = base ]; then dir="$BASE_TREE/frontend" sha="$BASE_SHA"; else dir="$FRONTEND" sha="$HEAD_SHA"; fi
    log "  $rev $sha: webServer $(cd "$dir" && node --input-type=module -e "const c = (await import('./playwright.config.ts')).default; process.stdout.write(c.webServer.command)")"
    log "  $rev: host $(hostname), start load $(load)"
    (cd "$dir" && STU771_REPORT="$out/$rev.json" STU771_OUT="$out/$rev-results" "$PW" test -c scripts/stu-771/measure.config.ts) >"$out/$rev.log" 2>&1
    code=$?
    node "$LIB" load-times "$out/$rev.json" >"$out/$rev.times" 2>&1
    count="$(sed -n 's/^count //p' "$out/$rev.times")"
    median="$(sed -n 's/^median //p' "$out/$rev.times")"
    log "  $rev: end load $(load), exit $code, loads $count, median ${median} ms, times (ms) $(head -n -2 "$out/$rev.times" | sort -n | tr '\n' ' ')"
    if [ "$code" -ne 0 ] || [ "$count" != 20 ]; then
      flunk "$name" "$rev did not complete all 20 loads (see $out/$rev.log)"
      return
    fi
    medians[$rev]="$median"
  done
  if ! node -e 'process.exit(Number(process.argv[1]) < Number(process.argv[2]) ? 0 : 1)' "${medians[head]}" "${medians[base]}"; then
    flunk "$name" "head median ${medians[head]} ms is not lower than base median ${medians[base]} ms"
    return
  fi
  log "  method: Playwright desktop project (Chromium 1440x900), 3 workers, fully parallel, 20 tests per revision; each mocks the API with the shared household fixture, then times performance.now() from just before page.goto('/') until getByRole('heading', { level: 1, name: 'Dashboard' }) is visible; the median of the 20"
  log "  base $BASE_SHA median ${medians[base]} ms; head $HEAD_SHA median ${medians[head]} ms"
  pass "$name"
}

# AC4: CI's e2e job passed on this exact head; its duration next to main's most recent passing e2e run.
scenario_ac4() {
  local name='PR head e2e passes in CI' slug run_id job
  slug="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || { flunk "$name" "gh cannot read the repository"; return; }
  e2e_job() {
    gh run view "$1" -R "$slug" --json jobs \
      -q '.jobs[] | select(.name == "e2e") | "\(.conclusion) \(.startedAt) \(.completedAt) \(.url)"'
  }
  duration() { node -e 'const [a, b] = process.argv.slice(1); process.stdout.write(String(Math.round((Date.parse(b) - Date.parse(a)) / 1000)))' "$1" "$2"; }
  run_id="$(gh run list -R "$slug" --workflow ci.yml --commit "$HEAD_SHA" --event pull_request --limit 1 --json databaseId -q '.[0].databaseId')"
  if [ -z "$run_id" ]; then
    flunk "$name" "no pull_request CI run for $HEAD_SHA yet"
    return
  fi
  read -r conclusion started completed url <<<"$(e2e_job "$run_id")"
  log "  head $HEAD_SHA: run $run_id, e2e $conclusion, $(duration "$started" "$completed")s, $url"
  if [ "$conclusion" != success ]; then
    flunk "$name" "the e2e job on $HEAD_SHA is '$conclusion'"
    return
  fi
  local main_id main_line
  for main_id in $(gh run list -R "$slug" --workflow ci.yml --branch main --event push --limit 30 --json databaseId -q '.[].databaseId'); do
    main_line="$(e2e_job "$main_id")"
    if [ "${main_line%% *}" = success ]; then
      read -r conclusion started completed url <<<"$main_line"
      log "  main: run $main_id ($(gh run view "$main_id" -R "$slug" --json headSha -q .headSha)), e2e success, $(duration "$started" "$completed")s, $url"
      pass "$name"
      return
    fi
  done
  flunk "$name" "no passing e2e job in main's last 30 CI runs"
}

# AC5: the PR lists exactly the changed spec paths, each with its preview dependency and replacement, and each edited
# spec keeps its test cases and its skip, fixme, only and fail rules.
scenario_ac5() {
  local name='preview compatibility edits match the PR record' out="$WORK/ac5" changed listed path
  mkdir -p "$out"
  if [ ! -f "$PR_BODY" ]; then
    flunk "$name" "no PR body at $PR_BODY"
    return
  fi
  changed="$(git -C "$REPO" diff --name-only "$BASE_SHA...HEAD" -- frontend/e2e | grep -E '\.ts$' | sort)"
  node "$LIB" pr-specs "$PR_BODY" >"$out/rows.tsv" || { flunk "$name" "could not read the touched-spec table"; return; }
  listed="$(cut -f1 "$out/rows.tsv" | sort)"
  log "  changed under frontend/e2e: ${changed:-none}"
  log "  listed in the PR: ${listed:-none}"
  if [ "$changed" != "$listed" ]; then
    flunk "$name" "the PR's touched-spec table does not list exactly the changed paths"
    return
  fi
  if awk -F'\t' 'NF != 3 || $2 == "" || $3 == "" { bad = 1 } END { exit !bad }' "$out/rows.tsv"; then
    flunk "$name" "a touched-spec row lacks its preview dependency or replacement"
    return
  fi
  [ -z "$changed" ] && { log "  no spec changed"; pass "$name"; return; }
  base_tree || { flunk "$name" "could not check out $BASE_REF"; return; }
  for path in $changed; do
    [[ "$path" == *.spec.ts ]] || continue
    if [ ! -f "$BASE_TREE/$path" ]; then
      flunk "$name" "$path is new, not an edit of a spec on $BASE_REF"
      return
    fi
    local rel="${path#frontend/}"
    (cd "$BASE_TREE/frontend" && "$PW" test --list --reporter=json "$rel") >"$out/base-list.json" 2>/dev/null
    (cd "$FRONTEND" && "$PW" test --list --reporter=json "$rel") >"$out/head-list.json" 2>/dev/null
    if ! diff <(node "$LIB" list-ids "$out/base-list.json") <(node "$LIB" list-ids "$out/head-list.json") >"$out/list.diff" \
      || [ ! -s "$out/base-list.json" ]; then
      flunk "$name" "$path does not keep the same test cases (see $out/list.diff)"
      return
    fi
    if ! diff <(node "$LIB" guard-lines "$BASE_TREE/$path") <(node "$LIB" guard-lines "$REPO/$path") >"$out/guards.diff"; then
      flunk "$name" "$path changed a skip, fixme, only or fail rule (see $out/guards.diff)"
      return
    fi
    log "  $path: $(node "$LIB" list-ids "$out/head-list.json" | wc -l) test cases and $(node "$LIB" guard-lines "$REPO/$path" | wc -l) skip/fixme/only/fail rules, unchanged"
  done
  pass "$name"
}

# AC6: everything about the suite but the webServer command and timeout is as it was.
scenario_ac6() {
  local name='preview migration preserves suite configuration' out="$WORK/ac6" summary
  mkdir -p "$out"
  base_tree || { flunk "$name" "could not check out $BASE_REF"; return; }
  if ! summary="$(node "$LIB" config-diff "$BASE_TREE/frontend/playwright.config.ts" "$FRONTEND/playwright.config.ts" 2>&1)"; then
    flunk "$name" "playwright.config.ts: $summary"
    return
  fi
  log "  config: $summary"
  local changed
  changed="$(git -C "$REPO" diff --name-only "$BASE_SHA" HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml \
    frontend/package.json frontend/pnpm-lock.yaml packages mobile/package.json '*.cjs' 'frontend/e2e/*.baseline' \
    'frontend/e2e/*.json' frontend/vite.config.ts frontend/tsconfig.e2e.json)"
  if [ -n "$changed" ]; then
    flunk "$name" "dependency declarations, hand-run .cjs scripts, their servers or the e2e tsconfig changed: $changed"
    return
  fi
  log "  unchanged: package.json files and lockfiles, every .cjs script, vite.config.ts (the dev server the .cjs scripts use), tsconfig.e2e.json"
  local script
  script="$(cd "$FRONTEND" && node -p 'require("./package.json").scripts["test:e2e"]')"
  log "  test:e2e: $script"
  if [[ "$script" == *--shard* || "$script" == *--retries* ]]; then
    flunk "$name" "test:e2e shards or sets retries"
    return
  fi
  (cd "$BASE_TREE/frontend" && "$PW" test --list --reporter=json) >"$out/base-list.json" 2>/dev/null
  (cd "$FRONTEND" && "$PW" test --list --reporter=json) >"$out/head-list.json" 2>/dev/null
  node "$LIB" list-ids "$out/base-list.json" >"$out/base-ids.txt"
  node "$LIB" list-ids "$out/head-list.json" >"$out/head-ids.txt"
  if [ ! -s "$out/head-ids.txt" ] || ! diff "$out/base-ids.txt" "$out/head-ids.txt" >"$out/ids.diff"; then
    flunk "$name" "test discovery differs from $BASE_REF (see $out/ids.diff)"
    return
  fi
  log "  discovery: $(wc -l <"$out/head-ids.txt") tests listed, identical to $BASE_REF"
  local readme="$FRONTEND/e2e/README.md"
  if ! grep -q 'vite preview' "$readme" || ! grep -q 'vite build' "$readme" || ! grep -q 'no dev-server mode' "$readme"; then
    flunk "$name" "e2e/README.md does not describe the build and preview serving and the dev-server position"
    return
  fi
  log "  README: describes vite build then vite preview, and that the suite has no dev-server mode"
  pass "$name"
}

declare -A NAMES=(
  [ac1]='e2e serves a built bundle'
  [ac2]='three consecutive local e2e runs pass cleanly'
  [ac3]='built bundle reduces Dashboard load median'
  [ac4]='PR head e2e passes in CI'
  [ac5]='preview compatibility edits match the PR record'
  [ac6]='preview migration preserves suite configuration'
)
SELECTED=("$@")
[ ${#SELECTED[@]} -eq 0 ] && SELECTED=(ac1 ac2 ac3 ac4 ac5 ac6)
for s in "${SELECTED[@]}"; do
  if [ -z "${NAMES[$s]:-}" ]; then
    log "unknown scenario: $s"
    exit 2
  fi
  log "== $s: ${NAMES[$s]}"
  "scenario_$s"
done

if [ ${#FAILED[@]} -gt 0 ]; then
  log "RESULT: ${#FAILED[@]} failed: ${FAILED[*]}"
  exit 1
fi
log "RESULT: all ${#SELECTED[@]} passed"
