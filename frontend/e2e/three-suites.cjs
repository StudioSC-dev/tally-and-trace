// STU-617 proof runners. Two scenarios, nothing secret: both use the environment the
// suites already need (see ./README.md): a guarded local DATABASE_URL (a throwaway
// `tt_test_*` database on a local Postgres), VIRTUAL_ENV (or backend/.venv),
// PLAYWRIGHT_PATH, and `psql` and `pnpm` on PATH. Not wired into CI.
//
//   three-suites.three-consecutive-runs
//     Runs record-dates, installment-review-batch and smooth-account-detail, complete,
//     three rounds in a row, and fails (exit 1) at the first suite that fails.
//   smooth-account-detail.panel-reservation-revert-and-fail
//     Runs smooth-account-detail scenario d (`d.section-held-still`) with the credit
//     panel's reserved height (must pass), then with only that reservation reverted in
//     CardCreditPanel.tsx (must fail on `d.section-held-still`), then restores the file
//     in a `finally` and checks it is byte-identical and the tree has no change to it.
//     The file must be unmodified when the script starts.
//
// Usage (from the repo root):
//   node frontend/e2e/three-suites.cjs three-consecutive-runs
//   node frontend/e2e/three-suites.cjs panel-reservation-revert-and-fail
// Exit 0 only when the scenario holds, 1 when it does not, 2 on a setup problem.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const SUITES = ['record-dates', 'installment-review-batch', 'smooth-account-detail']
const PANEL = path.join(REPO, 'frontend', 'src', 'components', 'CardCreditPanel.tsx')
const PANEL_REL = 'frontend/src/components/CardCreditPanel.tsx'
// The reservation, as the two edits it is made of, and what they were before it.
const RESERVATION = [
  ['space-y-1 min-h-[126px]">', 'space-y-1">'],
  ['<Skeleton className="h-10 w-3/5" />\n        <span role="status"', '<Skeleton className="h-5 w-3/5" />\n        <span role="status"'],
]

function run(args) {
  const r = spawnSync('node', args.map((a) => (a.endsWith('.cjs') ? path.join(__dirname, a) : a)), {
    cwd: REPO, env: process.env, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
const need = () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (see frontend/e2e/README.md)'); process.exit(2) }
}

function threeRuns() {
  need()
  const failures = []
  for (let round = 1; round <= 3; round++) {
    for (const suite of SUITES) {
      console.log(`\n##### round ${round}/3: ${suite}`)
      const { code, out } = run([`${suite}.cjs`])
      const result = (out.match(/^RESULT.*$/m) || ['(no RESULT line)'])[0]
      console.log(`##### round ${round}/3 ${suite}: exit ${code}; ${result}`)
      if (code !== 0) failures.push(`round ${round} ${suite}`)
      if (code !== 0) break
    }
    if (failures.length) break
  }
  console.log(failures.length === 0
    ? '\nthree-suites.three-consecutive-runs: PASS (3 rounds, every suite exit 0)'
    : `\nthree-suites.three-consecutive-runs: FAIL (${failures.join(', ')})`)
  process.exit(failures.length === 0 ? 0 : 1)
}

function revertAndFail() {
  need()
  const git = (...a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' })
  if (git('diff', '--quiet', 'HEAD', '--', PANEL_REL).status !== 0) {
    console.error(`${PANEL_REL} has uncommitted changes; refusing to touch it`)
    process.exit(2)
  }
  const original = fs.readFileSync(PANEL, 'utf8')
  let reverted = original
  for (const [reserved, before] of RESERVATION) {
    if (!reverted.includes(reserved)) { console.error(`the reservation is not in ${PANEL_REL}: "${reserved.slice(0, 40)}..."`); process.exit(2) }
    reverted = reverted.replace(reserved, before)
  }
  const restore = () => fs.writeFileSync(PANEL, original)
  process.on('SIGINT', () => { restore(); process.exit(130) })
  process.on('SIGTERM', () => { restore(); process.exit(143) })
  let withIt, without
  try {
    console.log('\n##### with the reservation')
    withIt = run(['smooth-account-detail.cjs', 'd'])
    console.log('\n##### only the reservation reverted')
    fs.writeFileSync(PANEL, reverted)
    without = run(['smooth-account-detail.cjs', 'd'])
  } finally {
    restore()
  }
  const clean = fs.readFileSync(PANEL, 'utf8') === original && git('diff', '--quiet', 'HEAD', '--', PANEL_REL).status === 0
  const passes = withIt.code === 0 && /PASS d\.section-held-still/.test(withIt.out)
  const fails = without.code === 1 && /FAIL d\.section-held-still/.test(without.out)
  console.log(`\nwith the reservation: exit ${withIt.code}, d.section-held-still ${passes ? 'passed' : 'NOT passed'}`)
  console.log(`reservation reverted: exit ${without.code}, d.section-held-still ${fails ? 'FAILED as required' : 'did NOT fail'}`)
  console.log(`tree restored and clean: ${clean}`)
  const ok = passes && fails && clean
  console.log(`\nsmooth-account-detail.panel-reservation-revert-and-fail: ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

const scenario = process.argv[2]
if (scenario === 'three-consecutive-runs') threeRuns()
else if (scenario === 'panel-reservation-revert-and-fail') revertAndFail()
else { console.error('usage: node three-suites.cjs three-consecutive-runs | panel-reservation-revert-and-fail'); process.exit(2) }
